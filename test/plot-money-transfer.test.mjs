import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pool from '../src/config/db.js';
import { up } from '../src/migrations/160_plot_money_transfers.js';
import { transferPlotMoney } from '../src/controllers/plotMoneyTransfer.controller.js';
import { transferInput } from '../src/services/plotMoneyTransfer.service.js';
import { currentTransactionDate } from '../src/services/transactionDate.service.js';

const body = overrides => ({ request_id: randomUUID(), target_plot_id: 2, amount: '100000', date: '2026-09-09', ...overrides });
test('validates amount, destination, dates and retry key before opening a transaction', () => {
  for (const amount of ['0', '-1', 'NaN', 'Infinity', '1.001', '1e5', '100x', null]) assert.throws(() => transferInput(body({ amount }), 1));
  for (const date of ['2026-02-30', 'not-a-date']) assert.throws(() => transferInput(body({ date }), 1));
  assert.throws(() => transferInput(body({ target_plot_id: '2x' }), 1));
  assert.throws(() => transferInput(body({ request_id: '' }), 1));
  assert.equal(transferInput(body({ amount: '0.01' }), 1).amount, 0.01);
});

const invoke = (input, paymentId = 1, user = { id: 1, role: 'admin' }) => new Promise((resolve, reject) => {
  const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(data) { resolve({ status: this.statusCode, ...data }); } };
  transferPlotMoney({ user, params: { id: paymentId }, body: input }, res, reject);
});

test('paired plot transfers reconcile with the cash-flow mirror and preserve atomicity', { skip: !process.env.PGLITE_MODULE }, async t => {
  const { PGlite } = await import(process.env.PGLITE_MODULE);
  const pg = new PGlite();
  const query = async (sql, values) => values ? pg.query(sql, values) : (await pg.exec(sql)).at(-1);
  const originalConnect = pool.connect;
  pool.connect = async () => ({ query, release() {} });
  try {
    await pg.exec(`CREATE TABLE users(id int PRIMARY KEY);
      CREATE TABLE sites(id int PRIMARY KEY);
      CREATE TABLE plots(id int PRIMARY KEY, site_id int REFERENCES sites(id), plot_no text, buyer_name text, booking_by text, status text, plot_tag text);
      CREATE TABLE app_schema_migrations(version text PRIMARY KEY);
      CREATE TABLE application_settings(site_id int, setting_key text, setting_value jsonb);
      CREATE TABLE user_sites(user_id int, site_id int);
      CREATE TABLE user_approval_modules(user_id int, module text);
      CREATE TABLE plot_payments(id serial PRIMARY KEY, plot_id int REFERENCES plots(id), site_id int, date date,
        payment_from text, payment_type text, amount numeric(15,2), narration text, buyer_name text, booked_by text,
        created_by int, status text, approved_by int, approved_at timestamptz, transaction_time time,
        cheque_status text, bank_details text, bank_name text, branch text, assigned_admin_id int, voucher_url text);
      CREATE TABLE cash_flow_entries(id serial PRIMARY KEY, cash_flow_month_id int, site_id int, date date,
        particular text, debit numeric, credit numeric, cash_type text, remarks text, created_by int,
        assigned_admin_id int, source_module text, source_id int, voucher_url text, status text,
        approved_by int, approved_at timestamptz, updated_at timestamptz, UNIQUE(source_module,source_id));
      CREATE FUNCTION ensure_site_cashflow_month(integer,date,integer) RETURNS integer LANGUAGE sql AS 'SELECT 1';
      INSERT INTO users VALUES (1),(2);
      INSERT INTO sites VALUES (1),(2);
      INSERT INTO plots VALUES (1,1,'A1','Source Buyer','Source Dealer','BOOKED',NULL), (2,1,'A2','Target Buyer','Target Dealer','BOOKED',NULL), (3,2,'B1','Other Buyer','Other Dealer','BOOKED',NULL);`);
    const sync = await readFile(new URL('../src/migrations/086_cashflow_mode_bucket.js', import.meta.url), 'utf8');
    await pg.exec(sync.match(/const BUCKET_FN = `([\s\S]*?)`;/)[1]);
    await pg.exec(sync.match(/const SYNC_FN = `([\s\S]*?)`;/)[1]);
    const posting = await readFile(new URL('../src/migrations/119_grandfather_pre_policy_cheques.js', import.meta.url), 'utf8');
    await pg.exec(posting.match(/CREATE OR REPLACE FUNCTION financial_transaction_posts\([\s\S]*?AS \$\$[\s\S]*?\$\$/)[0]);
    await pg.exec(`CREATE TRIGGER trg_sync_cfe_plot_payments AFTER INSERT OR UPDATE OR DELETE ON plot_payments FOR EACH ROW EXECUTE FUNCTION sync_cashflow_from_modules();
      INSERT INTO plot_payments(plot_id,site_id,date,payment_type,amount,created_by,status) VALUES (1,1,'2026-09-01','BANK',100000,1,'approved');`);
    await up();
    await up(); // Additive migration remains safe to rerun.
    let first;
    await t.test('₹1 lakh leaves A1, arrives in A2, and posts positive bank debit/credit', async () => {
      const input = body();
      first = await invoke(input);
      assert.equal(first.status, 201);
      assert.deepEqual(first.payments.map(p => [p.plot_id, Number(p.amount), p.narration, p.buyer_name]), [
        [1, -100000, 'TRANSFER FROM A1 TO A2', 'Source Buyer'],
        [2, 100000, 'TRANSFER MONEY GET FROM A1 INTO A2', 'Target Buyer'],
      ]);
      const sums = await query('SELECT plot_id, SUM(amount) AS total FROM plot_payments GROUP BY plot_id ORDER BY plot_id');
      assert.deepEqual(sums.rows.map(r => [r.plot_id, Number(r.total)]), [[1, 0], [2, 100000]]);
      const ledger = await query('SELECT debit,credit,cash_type,status FROM cash_flow_entries WHERE source_id = ANY($1::int[]) ORDER BY source_id', [first.payments.map(p => p.id)]);
      assert.deepEqual(ledger.rows.map(r => [Number(r.debit), Number(r.credit), r.cash_type, r.status]), [[100000, 0, 'bank', 'approved'], [0, 100000, 'bank', 'approved']]);
      assert.equal(Number((await query('SELECT amount FROM plot_payments WHERE id=1')).rows[0].amount), 100000);
      const retry = await invoke(input);
      assert.equal(retry.status, 200);
      assert.equal(retry.payments.length, 2);
      assert.equal((await query('SELECT * FROM plot_payments')).rows.length, 3);
      await assert.rejects(invoke({ ...input, amount: '1' }), /request ID/);
    });
    await t.test('over-transfer, same plot and non-visible receipt are rejected', async () => {
      await assert.rejects(invoke(body({ amount: '1' })), /remaining/);
      await assert.rejects(invoke(body({ target_plot_id: 1 })), /different/);
      await assert.rejects(invoke(body(), 1, { id: 2, role: 'sub_admin', permissionsByModule: new Map([['plot_payments', { can_view_all: false }]]) }), /not found/);
    });
    await t.test('linked legs and original accounting fields cannot be edited or deleted', async () => {
      for (const id of [1, ...first.payments.map(p => p.id)]) {
        await assert.rejects(query('UPDATE plot_payments SET amount=42 WHERE id=$1', [id]), /cannot be changed/);
        await assert.rejects(query('DELETE FROM plot_payments WHERE id=$1', [id]), /cannot be deleted|foreign key/);
      }
    });
    const receivedId = first.payments[1].id;
    await t.test('partial transfers work across locations and cannot spend the same receipt twice', async () => {
      await invoke(body({ target_plot_id: 3, amount: '30000.25' }), receivedId);
      await invoke(body({ target_plot_id: 3, amount: '69999.75' }), receivedId);
      await assert.rejects(invoke(body({ target_plot_id: 3, amount: '0.01' }), receivedId), /remaining/);
    });
    await t.test('a destination insert failure rolls back debit, audit and cash-flow rows', async () => {
      await query("INSERT INTO plot_payments(plot_id,site_id,date,payment_type,amount,created_by,status) VALUES (1,1,'2026-09-09','BANK',100,1,'approved')");
      const id = (await query('SELECT MAX(id) AS id FROM plot_payments')).rows[0].id;
      await pg.exec("ALTER TABLE plot_payments ADD CONSTRAINT test_destination_failure CHECK (money_transfer_role IS DISTINCT FROM 'credit' OR plot_id <> 2) NOT VALID");
      const before = (await query('SELECT COUNT(*) AS count FROM cash_flow_entries')).rows[0].count;
      const input = body({ amount: '100' });
      await assert.rejects(invoke(input, id), /test_destination_failure/);
      assert.equal((await query('SELECT * FROM plot_money_transfers WHERE id=$1', [input.request_id])).rows.length, 0);
      assert.equal((await query('SELECT COUNT(*) AS count FROM cash_flow_entries')).rows[0].count, before);
      await pg.exec('ALTER TABLE plot_payments DROP CONSTRAINT test_destination_failure');
    });
    await t.test('orphan transfer audit cannot commit without its pair', async () => {
      await assert.rejects(query("INSERT INTO plot_money_transfers(id,source_payment_id,source_plot_id,target_plot_id,amount,date,requested_date,created_by) VALUES ($1,1,1,2,1,'2026-09-09','2026-09-09',1)", [randomUUID()]), /matching debit and credit/);
    });
    await t.test('ordinary receipts can still be edited and deleted', async () => {
      const id = (await query("INSERT INTO plot_payments(plot_id,site_id,date,payment_type,amount,created_by,status) VALUES (1,1,'2026-09-09','BANK',1,1,'pending') RETURNING id")).rows[0].id;
      await query('UPDATE plot_payments SET amount=2 WHERE id=$1', [id]);
      await query('DELETE FROM plot_payments WHERE id=$1', [id]);
      assert.equal((await query('SELECT * FROM plot_payments WHERE id=$1', [id])).rows.length, 0);
    });
    await t.test('both location access and approval permission are required; locked dates and retries stay consistent', async () => {
      const id = (await query("INSERT INTO plot_payments(plot_id,site_id,date,payment_type,amount,created_by,status) VALUES (1,1,'2026-09-09','BANK',100,1,'approved') RETURNING id")).rows[0].id;
      const user = { id: 2, role: 'sub_admin', permissionsByModule: new Map([['plot_payments', { can_view_all: true }]]) };
      const input = body({ target_plot_id: 3, amount: '10', date: '2026-09-08' });
      await query('INSERT INTO user_sites VALUES (2,1)');
      await assert.rejects(invoke(input, id, user), /Access denied/);
      await query('INSERT INTO user_sites VALUES (2,2)');
      await assert.rejects(invoke(input, id, user), /approval permission/);
      await query("INSERT INTO user_approval_modules VALUES (2,'plot_payment')");
      await query("INSERT INTO application_settings VALUES (2,'transaction_date_editable','false')");
      const result = await invoke(input, id, user);
      assert.equal(new Date(result.transfer.date).toISOString().slice(0, 10), currentTransactionDate());
      assert.equal((await invoke(input, id, user)).status, 200);
      await assert.rejects(invoke({ ...input, date: '2026-09-07' }, id, user), /request ID/);
      const balance = Number((await query('SELECT SUM(amount) AS amount FROM plot_payments WHERE plot_id=1')).rows[0].amount);
      await query("INSERT INTO plot_payments(plot_id,site_id,date,payment_type,amount,created_by,status) VALUES (1,1,'2026-09-09','BANK',$1,1,'approved')", [-balance]);
      await assert.rejects(invoke(body({ amount: '1' }), id), /source plot balance/);
    });
    await t.test('unapproved credits, pending and bounced cheques cannot be transferred', async () => {
      for (const [status, mode, cheque] of [['pending','BANK',null], ['approved','CHEQUE','PENDING'], ['approved','CHEQUE','BOUNCED']]) {
        const id = (await query("INSERT INTO plot_payments(plot_id,site_id,date,payment_type,amount,created_by,status,cheque_status) VALUES (1,1,'2026-09-09',$1,100,1,$2,$3) RETURNING id", [mode,status,cheque])).rows[0].id;
        await assert.rejects(invoke(body({ amount: '1' }), id), /Approve the received credit/);
      }
    });
  } finally { pool.connect = originalConnect; await pg.close(); }
});
