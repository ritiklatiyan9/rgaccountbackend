import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import express from 'express';
import jwt from 'jsonwebtoken';
import pool from '../src/config/db.js';
import { createExpense, updateExpense, getExpense } from '../src/controllers/expense.controller.js';
import { listPartyLinks } from '../src/controllers/transactionParty.controller.js';
import { getExpensesPageData } from '../src/graphql/services/expenses.service.js';
import { schema } from '../src/graphql/schema.js';
import expenseRoutes from '../src/routes/expense.routes.js';
import { transactionTimeMiddleware } from '../src/services/transactionTime.service.js';
import { loyaltyVaultMiddleware } from '../src/services/loyaltyVaultContext.service.js';
import errorMiddleware from '../src/middlewares/error.middleware.js';

const sunny = { id: 12, role: 'sub_admin', organization_id: 1,
  permissionsByModule: new Map([['expenses', { can_view_all: false }]]) };
const admin = { id: 1, role: 'admin', organization_id: 1 };
const invoke = (handler, { body = {}, id = '1', user = sunny, query = {} } = {}) => new Promise((resolve, reject) => {
  const res = { statusCode: 200, status(code) { this.statusCode = code; return this; },
    json(data) { resolve({ status: this.statusCode, ...data }); } };
  handler({ body, params: { id }, user, query }, res, reject);
});

async function fixture(t) {
  // All rows and trigger failures live in this isolated engine. Never open the
  // configured application database or write a customer financial record.
  const pg = new PGlite();
  const oldQuery = pool.query, oldConnect = pool.connect;
  const query = (sql, params) => pg.query(sql, params);
  pool.query = query;
  pool.connect = async () => ({ query, release() {} });
  t.after(async () => { pool.query = oldQuery; pool.connect = oldConnect; await pg.close(); });
  await pg.exec(`
    CREATE TABLE sites(id integer PRIMARY KEY, name text, city text, state text);
    INSERT INTO sites VALUES (5, 'OM Associates', '', ''), (7, 'Other site', '', '');
    CREATE TABLE users(id integer PRIMARY KEY, name text, email text);
    INSERT INTO users VALUES (1, 'Administrator', 'admin@example.test'), (12, 'Sunny', 'sunnys@gmail.com');
    CREATE TABLE members(id integer PRIMARY KEY, site_id integer REFERENCES sites(id), full_name text, phone text);
    INSERT INTO members VALUES (20, 5, 'Linked client', '9999999999'),
      (21, 5, 'Replacement client', '8888888888'), (22, 7, 'Other-site client', '7777777777');
    CREATE TABLE expenses(id serial PRIMARY KEY, site_id integer, date date, from_entity text, to_entity text,
      payment_mode text, debit numeric DEFAULT 0, credit numeric DEFAULT 0, remark text, account_no text,
      branch text, category text, sub_category text, assigned_user_id integer, assigned_admin_id integer,
      voucher_urls text[], voucher_url text, bill_urls text[], bill_url text, status text, created_by integer,
      approved_by integer, approved_at timestamptz, cheque_no text, cheque_status text,
      customer_signature_url text, authority_signature_url text, created_at timestamptz DEFAULT now(),
      updated_at timestamptz DEFAULT now(), display_order integer, transaction_time time,
      entry_transfer_id text, entry_transfer_role text, tds_amount numeric, tds_rate numeric,
      tds_mode text, tds_section text, tds_module text, tds_deductee_name text, tds_pan text);
    CREATE TABLE transaction_party_links(source_key varchar(40), source_id integer, site_id integer REFERENCES sites(id),
      member_id integer REFERENCES members(id), direction text CHECK (direction IN ('debit','credit')),
      created_by integer, updated_at timestamptz DEFAULT now(), PRIMARY KEY(source_key, source_id));
    CREATE TABLE ledger_entries(id integer, debit numeric, credit numeric);
    INSERT INTO ledger_entries VALUES (1, 1000, 50);
    CREATE FUNCTION financial_transaction_posts(text, text, text, text) RETURNS boolean
      LANGUAGE sql IMMUTABLE AS $$ SELECT $2 = 'approved' $$;
    CREATE TABLE farmers(id integer, site_id integer, name text);
    CREATE TABLE farmer_payments(LIKE expenses, farmer_id integer, amount numeric,
      remarks text, bank_account_no text, bank_ifsc text);
    CREATE TABLE plots(id integer, plot_no text);
    CREATE TABLE plot_commissions_v2(id integer, plot_id integer, agent_id integer);
    CREATE TABLE plot_commission_payments(LIKE expenses, plot_commission_id integer, amount numeric, remarks text);
    CREATE TABLE vendor_commitments(id integer, vendor_name text);
    CREATE TABLE vendor_payments(LIKE expenses, commitment_id integer, amount numeric, payment_date date, note text);
    CREATE TABLE cash_flow_months(id integer, ledger_type text);
    CREATE TABLE cash_flow_entries(LIKE expenses, cash_flow_month_id integer, to_name text, particular text,
      remarks text, cash_type text, source_module text);
    CREATE TABLE day_book(LIKE expenses, particular text, remarks text, entry_type text,
      farmer_payment_id integer, commission_id integer, vendor_payment_id integer);
  `);
  return { pg, query };
}

const expenseBody = (overrides = {}) => ({ site_id: 5, date: '2026-10-18', debit: 710,
  category: 'Staff food', related_member_id: '20', ...overrides });

test('a sub-admin expense and its client save together and are visible to admin detail, list and GraphQL data', async t => {
  const { query } = await fixture(t);
  const saved = await invoke(createExpense, { body: expenseBody() });
  const expected = { member_id: 20, name: 'Linked client', phone: '9999999999', direction: 'debit' };
  assert.equal(saved.status, 201);
  assert.deepEqual(saved.expense.related_party, expected);
  const detail = await invoke(getExpense, { id: saved.expense.id, user: admin });
  assert.deepEqual(detail.expense.related_party, expected);
  const links = await invoke(listPartyLinks, { user: admin, query: { site_id: 5, targets: 'expense' } });
  assert.deepEqual(links.links[`expense:${saved.expense.id}`], expected);
  const page = await getExpensesPageData(5, { filters: { only_site: true }, limit: 0 });
  assert.equal(page.expenses.length, 1);
  assert.deepEqual(page.expenses[0].related_party, expected);
  assert.equal(page.expenses[0].created_by, 12);
  assert.equal(page.expenses[0].created_by_name, 'Sunny');
  const relatedType = schema.getType('ExpenseEntry').getFields().related_party.type;
  assert.deepEqual(Object.keys(relatedType.getFields()), ['member_id', 'name', 'phone', 'direction']);
  assert.deepEqual((await query('SELECT * FROM ledger_entries')).rows, [{ id: 1, debit: '1000', credit: '50' }]);
});

test('a failed link write rolls back the expense instead of silently accepting an unlinked expense', async t => {
  const { pg, query } = await fixture(t);
  await pg.exec(`CREATE FUNCTION reject_link() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'Link storage unavailable'; END $$;
    CREATE TRIGGER reject_link BEFORE INSERT ON transaction_party_links FOR EACH ROW EXECUTE FUNCTION reject_link();`);
  await assert.rejects(invoke(createExpense, { body: expenseBody() }), /Link storage unavailable/);
  assert.equal((await query('SELECT count(*)::int AS n FROM expenses')).rows[0].n, 0);
  assert.equal((await query('SELECT count(*)::int AS n FROM transaction_party_links')).rows[0].n, 0);
});

test('invalid and other-site clients reject the whole create with a clear actionable error', async t => {
  const { query } = await fixture(t);
  for (const memberId of ['20junk', '-1', '1.5', '999999999999', undefined]) {
    await assert.rejects(invoke(createExpense, { body: expenseBody({ related_member_id: memberId }) }),
      error => error.statusCode === 400 && /valid linked client/.test(error.message));
  }
  await assert.rejects(invoke(createExpense, { body: expenseBody({ related_member_id: 22 }) }),
    error => error.statusCode === 409 && /same site/.test(error.message));
  assert.equal((await query('SELECT count(*)::int AS n FROM expenses')).rows[0].n, 0);
});

test('link-only replacement and clear preserve approved amounts and workflow; omitted field leaves a link untouched', async t => {
  const { query } = await fixture(t);
  const { expense } = await invoke(createExpense, { body: expenseBody() });
  await query("UPDATE expenses SET status = 'approved', approved_by = 1, approved_at = '2026-10-18T00:00:00Z' WHERE id = $1", [expense.id]);
  const before = (await query('SELECT * FROM expenses WHERE id=$1', [expense.id])).rows[0];
  const edited = await invoke(updateExpense, { id: expense.id, body: { related_member_id: 21 } });
  assert.equal(edited.expense.related_party.member_id, 21);
  assert.deepEqual((await query('SELECT * FROM expenses WHERE id=$1', [expense.id])).rows[0], before);
  await invoke(updateExpense, { id: expense.id, body: { bill_urls: [] } });
  assert.equal((await invoke(getExpense, { id: expense.id, user: admin })).expense.related_party.member_id, 21);
  const cleared = await invoke(updateExpense, { id: expense.id, body: { related_member_id: null } });
  assert.equal(cleared.expense.related_party, null);
  assert.equal((await query('SELECT count(*)::int AS n FROM transaction_party_links')).rows[0].n, 0);
  const after = (await query('SELECT * FROM expenses WHERE id=$1', [expense.id])).rows[0];
  for (const field of ['status', 'approved_by', 'approved_at', 'debit', 'credit']) assert.deepEqual(after[field], before[field]);
});

test('an invalid linked client cannot partially change an existing expense or its previous link', async t => {
  const { query } = await fixture(t);
  const { expense } = await invoke(createExpense, { body: expenseBody() });
  await assert.rejects(invoke(updateExpense, { id: expense.id, body: { debit: 999, related_member_id: 22 } }),
    error => error.statusCode === 409);
  assert.equal((await query('SELECT debit FROM expenses WHERE id=$1', [expense.id])).rows[0].debit, '710');
  assert.equal((await invoke(getExpense, { id: expense.id, user: admin })).expense.related_party.member_id, 20);
});

test('link storage failure during edit rolls back both the financial edit and its approval reset', async t => {
  const { pg, query } = await fixture(t);
  const { expense } = await invoke(createExpense, { body: expenseBody() });
  await query("UPDATE expenses SET status='approved', approved_by=1, approved_at='2026-10-18T00:00:00Z' WHERE id=$1", [expense.id]);
  const before = (await query('SELECT * FROM expenses WHERE id=$1', [expense.id])).rows[0];
  await pg.exec(`CREATE FUNCTION reject_link_update() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'Cannot update linked client'; END $$;
    CREATE TRIGGER reject_link_update BEFORE UPDATE ON transaction_party_links
      FOR EACH ROW EXECUTE FUNCTION reject_link_update();`);
  await assert.rejects(invoke(updateExpense, { id: expense.id, body: { debit: 999, related_member_id: 21 } }),
    /Cannot update linked client/);
  assert.deepEqual((await query('SELECT * FROM expenses WHERE id=$1', [expense.id])).rows[0], before);
  assert.equal((await invoke(getExpense, { id: expense.id, user: admin })).expense.related_party.member_id, 20);
});

test('the full expense route keeps client-only saves outside financial updates despite a transaction-time header', async t => {
  const { pg, query } = await fixture(t);
  const { expense } = await invoke(createExpense, { body: expenseBody() });
  await pg.exec(`ALTER TABLE users ADD COLUMN role text, ADD COLUMN token_version integer DEFAULT 0,
      ADD COLUMN is_active boolean DEFAULT true, ADD COLUMN organization_id integer DEFAULT 1;
    UPDATE users SET role = CASE WHEN id=1 THEN 'admin' ELSE 'sub_admin' END;
    CREATE TABLE user_sessions(id integer, user_id integer, logout_time timestamptz);
    ALTER TABLE expenses ADD COLUMN loyalty_vault_holder_type text, ADD COLUMN loyalty_vault_holder_id integer,
      ADD COLUMN loyalty_vault_assigned_by integer, ADD COLUMN tds_revision text;
    UPDATE expenses SET status='approved',approved_by=1,approved_at='2026-10-18T00:00:00Z',
      transaction_time='11:12:13',loyalty_vault_holder_type='user',loyalty_vault_holder_id=12,
      loyalty_vault_assigned_by=12,tds_amount=10,tds_rate=2,tds_mode='manual',tds_revision='preserve-tds';
    CREATE FUNCTION reject_financial_update() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'Client link must not update the financial row'; END $$;
    CREATE TRIGGER reject_financial_update BEFORE UPDATE ON expenses FOR EACH ROW
      EXECUTE FUNCTION reject_financial_update();`);
  const before = (await query('SELECT * FROM expenses WHERE id=$1', [expense.id])).rows[0];
  // Only cryptographic verification is stubbed. The actual route still performs
  // its database-backed active user/session checks and permission middleware.
  t.mock.method(jwt, 'verify', () => ({ id: 1, role: 'admin', version: 0 }));
  const app = express();
  app.use(express.json());
  app.use(transactionTimeMiddleware);
  app.use(loyaltyVaultMiddleware);
  app.use('/expenses', expenseRoutes);
  app.use(errorMiddleware);
  const server = await new Promise((resolve, reject) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    listener.once('error', reject);
  });
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  for (const memberId of [21, null]) {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/expenses/${expense.id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer fixture-only',
        'X-Transaction-Time': '22:23:24' },
      body: JSON.stringify({ related_member_id: memberId }),
    });
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    assert.equal(result.expense.related_party?.member_id || null, memberId);
    assert.deepEqual((await query('SELECT * FROM expenses WHERE id=$1', [expense.id])).rows[0], before);
  }
  assert.deepEqual((await query('SELECT * FROM ledger_entries')).rows, [{ id: 1, debit: '1000', credit: '50' }]);
});
