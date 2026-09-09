import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pool from '../src/config/db.js';
import { up } from '../src/migrations/159_partner_profit_payments.js';
import { createPartnerPayment, listPartnerPayments, voidPartnerPayment } from '../src/controllers/partnerPayments.controller.js';
import { getPartnerProfitPaid, partnerPaidByMember, paymentPartners } from '../src/services/partnerPayments.service.js';
import { getRunningExpense, getExpenseBreakdown, getSiteBalanceDetail } from '../src/graphql/services/kpi.service.js';

// Optional embedded PostgreSQL for repeatable, network-free verification. No
// application dependency is required; point PGLITE_MODULE at a temporary install.
if (process.env.PGLITE_MODULE) {
  const { PGlite } = await import(process.env.PGLITE_MODULE);
  const pg = new PGlite();
  const postingSource = await readFile(new URL('../src/migrations/119_grandfather_pre_policy_cheques.js', import.meta.url), 'utf8');
  const bucketSource = await readFile(new URL('../src/migrations/086_cashflow_mode_bucket.js', import.meta.url), 'utf8');
  await pg.exec(postingSource.match(/CREATE OR REPLACE FUNCTION financial_transaction_posts\([\s\S]*?AS \$\$[\s\S]*?\$\$/)[0]);
  await pg.exec(bucketSource.match(/CREATE OR REPLACE FUNCTION cashflow_mode_bucket\([\s\S]*?AS \$\$[\s\S]*?\$\$/)[0]);
  const query = async (sql, values) => {
    const result = values ? await pg.query(sql, values) : (await pg.exec(sql)).at(-1);
    return { ...result, rowCount: result.affectedRows ?? result.rows.length };
  };
  pool.connect = async () => ({ query, release() {} });
  pool.query = query;
  pool.end = async () => pg.close();
}

const invoke = (handler, req) => new Promise((resolve, reject) => {
  const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { resolve({ status: this.statusCode, body }); } };
  handler({ user: { id: 1, role: 'admin' }, params: { id: '1' }, body: {}, query: {}, ...req }, res, reject);
});

test('payment, bank, duplicate retry, cutoff and void reconcile without reducing profit', { skip: !process.env.PGLITE_MODULE && process.env.PARTNER_PAYMENTS_DB_TESTS !== '1' }, async () => {
  const db = await pool.connect();
  const schema = `partner_payments_test_${process.pid}`;
  const originalQuery = pool.query;
  const originalConnect = pool.connect;
  try {
    await db.query('BEGIN');
    await db.query(`CREATE SCHEMA ${schema}`);
    await db.query(`SET LOCAL search_path TO ${schema}, public`);
    await db.query(`CREATE TABLE sites(id int PRIMARY KEY);
      CREATE TABLE users(id int PRIMARY KEY, name text, role text);
      CREATE TABLE members(id int PRIMARY KEY, full_name text, phone text, photo text);
      CREATE TABLE bank_accounts(id int PRIMARY KEY, site_id int, name text, is_active boolean DEFAULT true);
      CREATE TABLE site_partner_shares(site_id int, member_id int, share_pct numeric);
      CREATE TABLE farmers(id int PRIMARY KEY, site_id int);
      CREATE TABLE land_partner_shares(farmer_id int, member_id int);
      CREATE TABLE app_schema_migrations(version text PRIMARY KEY);
      CREATE TABLE imprest_ledger(user_id int, site_id int, amount numeric, created_at timestamptz);
      CREATE TABLE imprest_allocations(site_id int, status text, amount numeric, from_own_float boolean, created_at timestamptz);
      CREATE TABLE cash_flow_entries(id serial PRIMARY KEY, cash_flow_month_id int, site_id int, date date,
        transaction_time time, particular varchar(500), debit numeric DEFAULT 0, credit numeric DEFAULT 0,
        cash_type text, bank_account_id int, remarks text, created_by int, source_module text, source_id int,
        voucher_url text, status text, approved_by int, approved_at timestamptz, updated_at timestamptz,
        UNIQUE(source_module,source_id));
      CREATE FUNCTION ${schema}.ensure_site_cashflow_month(integer,date,integer) RETURNS integer LANGUAGE sql AS 'SELECT 1';
      CREATE VIEW ledger_entries AS SELECT id::text, site_id, date AS entry_date, source_module AS source_key,
        source_id, debit, credit, cash_type AS bucket, 'site'::text AS ledger_type
        FROM cash_flow_entries WHERE financial_transaction_posts('debit',status,cash_type,NULL)
          AND date BETWEEN DATE '1900-01-01' AND DATE '2100-12-31';
      INSERT INTO sites VALUES(1),(2);
      INSERT INTO users VALUES(1,'Test admin','admin');
      INSERT INTO members VALUES(1,'Partner A','9999999991',NULL),(2,'Land partner','9999999992',NULL),(3,'Unrelated partner','9999999993',NULL);
      INSERT INTO bank_accounts(id,site_id,name) VALUES(1,1,'Site one bank'),(2,2,'Site two bank');
      INSERT INTO site_partner_shares VALUES(1,1,50),(2,3,100);
      INSERT INTO farmers VALUES(1,1);
      INSERT INTO land_partner_shares VALUES(1,2);
      INSERT INTO cash_flow_entries(site_id,date,credit,debit,cash_type,source_module,source_id,status)
        VALUES(1,'2026-01-01',500,0,'cash','plot_payments',1,'approved'),
              (1,'2026-01-01',0,100,'cash','expenses',1,'approved');`);
    const adapter = { query: (sql, args) => ['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql) ? Promise.resolve({ rows: [] }) : db.query(sql, args), release() {} };
    pool.query = adapter.query;
    pool.connect = async () => adapter;
    await up(pool);
    await up(pool); // Safe to re-run on startup.
    const input = { member_id: 1, amount: '30.25', date: '2026-01-15', payment_mode: 'CASH', request_id: randomUUID() };
    const first = await invoke(createPartnerPayment, { body: input });
    assert.equal(first.status, 201);
    const retry = await invoke(createPartnerPayment, { body: input });
    assert.equal(retry.body.payment.id, first.body.payment.id);
    const conflict = await invoke(createPartnerPayment, { body: { ...input, amount: '31.25' } });
    assert.equal(conflict.status, 409);
    const foreignPartner = await invoke(createPartnerPayment, { body: { ...input, member_id: 3, request_id: randomUUID() } });
    assert.equal(foreignPartner.status, 400);
    const wrongBank = await invoke(createPartnerPayment, { body: { ...input, payment_mode: 'BANK', bank_account_id: 2, request_id: randomUUID() } });
    assert.equal(wrongBank.status, 400);
    const bank = await invoke(createPartnerPayment, { body: { ...input, member_id: 2, amount: '40.50', date: '2026-02-01', payment_mode: 'UPI', bank_account_id: 1, request_id: randomUUID() } });
    assert.equal(bank.status, 201);
    assert.equal((await db.query("SELECT COUNT(*)::int AS n FROM cash_flow_entries WHERE source_module='partner_profit_payments'")).rows[0].n, 2);
    assert.equal((await db.query("SELECT bank_account_id FROM cash_flow_entries WHERE source_module='partner_profit_payments' AND source_id=$1", [bank.body.payment.id])).rows[0].bank_account_id, 1);
    assert.equal(await getPartnerProfitPaid(1, '2026-03-01'), 70.75);
    assert.equal(await getPartnerProfitPaid(1, '2026-02-01'), 30.25, 'end date is exclusive');
    assert.equal(await getPartnerProfitPaid(2, '2026-03-01'), 0, 'site scope cannot leak');
    assert.equal(await getRunningExpense(1, '2026-03-01'), 100);
    assert.equal((await getExpenseBreakdown(1, '2026-01-01', '2026-03-01')).total, 100);
    assert.equal((await getSiteBalanceDetail(1, '2026-01-01', '2026-03-01')).siteBalance, 329.25);
    assert.equal((await partnerPaidByMember(1, '2026-03-01')).reduce((sum, row) => sum + row.paid, 0), 70.75);
    await db.query('DELETE FROM site_partner_shares WHERE site_id=1');
    assert.ok((await paymentPartners(1)).some((row) => row.id === 1), 'history retains a recipient after their split is removed');
    const history = await invoke(listPartnerPayments, { query: { end: '2026-02-01' } });
    assert.equal(history.body.entries.length, 1);
    assert.equal(history.body.entries[0].posted_amount, 30.25);
    const voidReq = { params: { id: '1', paymentId: String(first.body.payment.id) }, body: { reason: 'Duplicate entered outside this request' } };
    assert.equal((await invoke(voidPartnerPayment, voidReq)).status, 200);
    assert.equal((await invoke(voidPartnerPayment, voidReq)).status, 409);
    assert.equal((await invoke(createPartnerPayment, { body: input })).status, 409, 'a voided request cannot be replayed as paid');
    assert.equal(await getPartnerProfitPaid(1, '2026-03-01'), 40.50);
    assert.equal(await getRunningExpense(1, '2026-03-01'), 100);
    assert.equal((await getSiteBalanceDetail(1, '2026-01-01', '2026-03-01')).siteBalance, 359.50);
    const finalHistory = await invoke(listPartnerPayments, {});
    assert.equal(finalHistory.body.entries.length, 2);
    const voided = finalHistory.body.entries.find((entry) => entry.status === 'rejected');
    assert.equal(voided.posted_amount, 0);
    assert.ok(voided.void_reason);
  } finally {
    pool.query = originalQuery; pool.connect = originalConnect;
    await db.query('ROLLBACK'); db.release(); await pool.end();
  }
});
