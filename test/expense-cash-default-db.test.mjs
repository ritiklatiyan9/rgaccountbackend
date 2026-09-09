import test from 'node:test';
import assert from 'node:assert/strict';
import pool from '../src/config/db.js';
import { up } from '../src/migrations/157_expense_cash_default.js';

test('cash expense lifecycle debits its creator once and leaves admin custody intact', {
  skip: process.env.EXPENSE_CASH_DB_TESTS !== '1',
}, async () => {
  const db = await pool.connect();
  const schema = `expense_cash_test_${process.pid}`;
  try {
    await db.query('BEGIN');
    // Private, rollback-only fixtures. No real records or sequences are used.
    await db.query(`CREATE SCHEMA ${schema}`);
    await db.query(`SET LOCAL search_path TO ${schema}, public`);
    await db.query('CREATE TABLE app_schema_migrations (version text PRIMARY KEY)');
    await db.query('CREATE TABLE users (id integer PRIMARY KEY, role text, is_active boolean DEFAULT true)');
    await db.query('CREATE TABLE expenses (id integer PRIMARY KEY, site_id integer, created_by integer, debit numeric DEFAULT 0, credit numeric DEFAULT 0, payment_mode text, status text, cheque_status text)');
    await db.query(`CREATE TABLE imprest_ledger (
      id serial PRIMARY KEY, user_id integer, site_id integer, type text,
      reference_id integer, source_module text, amount numeric, balance_after numeric,
      remarks text, created_by integer, proof_key text, created_at timestamptz DEFAULT now()
    )`);
    await db.query(`CREATE UNIQUE INDEX ON imprest_ledger(user_id,site_id,source_module,reference_id,type) WHERE source_module IS NOT NULL`);
    await db.query(`CREATE TABLE imprest_debit_reservations (
      source_module text, reference_id integer, user_id integer, site_id integer,
      amount numeric, remarks text, proof_key text, created_at timestamptz DEFAULT now(),
      updated_at timestamptz DEFAULT now(), PRIMARY KEY(source_module,reference_id)
    )`);
    for (const fn of ['refresh_imprest_balance_snapshots', 'imprest_debit_is_active', 'reconcile_imprest_debit', 'sync_universal_imprest_from_source']) {
      const { rows } = await db.query(`SELECT pg_get_functiondef(p.oid) AS definition FROM pg_proc p
        JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname=$1`, [fn]);
      assert.equal(rows.length, 1, `${fn} must have one canonical implementation`);
      await db.query(rows[0].definition.replace(`FUNCTION public.${fn}(`, `FUNCTION ${schema}.${fn}(`));
    }
    await db.query(`CREATE TRIGGER imprest_posting AFTER INSERT OR UPDATE OR DELETE ON expenses
      FOR EACH ROW EXECUTE FUNCTION sync_universal_imprest_from_source()`);
    await db.query("INSERT INTO users(id,role) VALUES (12,'sub_admin'),(7,'admin')");
    await db.query("INSERT INTO imprest_ledger(user_id,site_id,type,amount,balance_after) VALUES (12,5,'TRANSFER_IN',815067,815067)");
    // Seed the legacy pending row before the new normalizer is installed.
    await db.query("INSERT INTO expenses(id,site_id,created_by,debit,status) VALUES (1,5,12,710,'pending')");
    const adapter = { connect: async () => ({
      query: (sql, args) => ['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)
        ? Promise.resolve({ rows: [] }) : db.query(sql, args), release() {},
    }) };
    await up(adapter);
    await up(adapter);
    assert.equal((await db.query('SELECT payment_mode FROM expenses WHERE id=1')).rows[0].payment_mode, null, 'no broad history rewrite');
    const balance = async () => Number((await db.query('SELECT SUM(amount) AS balance FROM imprest_ledger WHERE user_id=12 AND site_id=5')).rows[0].balance);
    const reserved = async () => Number((await db.query('SELECT COALESCE(SUM(amount),0) AS amount FROM imprest_debit_reservations')).rows[0].amount);
    await db.query("UPDATE expenses SET status='approved' WHERE id=1");
    assert.equal(await balance(), 814357);
    assert.equal(await reserved(), 0);
    await db.query("UPDATE expenses SET status='approved' WHERE id=1");
    assert.equal(await balance(), 814357, 'retry must not charge twice');
    assert.equal((await db.query("SELECT COUNT(*)::int AS n FROM imprest_ledger WHERE type='EXPENSE'")).rows[0].n, 1);
    // Cash books fall by 710 and held float falls by 710: admin custody is unchanged.
    assert.equal(1000000 - 710 - await balance(), 1000000 - 815067);
    await db.query("UPDATE expenses SET status='rejected' WHERE id=1");
    assert.equal(await balance(), 815067);
    await db.query("UPDATE expenses SET status='pending' WHERE id=1");
    assert.equal(await reserved(), 710);
    assert.equal(await balance(), 815067);
    await db.query("UPDATE expenses SET status='approved' WHERE id=1");
    assert.equal(await balance(), 814357);
    await db.query('DELETE FROM expenses WHERE id=1');
    assert.equal(await balance(), 815067);
    let id = 2;
    for (const mode of [null, '', '   ', 'cash']) {
      await db.query("INSERT INTO expenses(id,site_id,created_by,debit,payment_mode,status) VALUES ($1,5,12,710,$2,'waiting')", [id, mode]);
      assert.equal(await reserved(), 710);
      assert.equal((await db.query('SELECT payment_mode FROM expenses WHERE id=$1', [id])).rows[0].payment_mode, 'CASH');
      await db.query('DELETE FROM expenses WHERE id=$1', [id++]);
    }
    for (const mode of ['BANK', 'UPI', 'NEFT', 'CHEQUE', 'ADJUST']) {
      await db.query("INSERT INTO expenses(id,site_id,created_by,debit,payment_mode,status) VALUES ($1,5,12,710,$2,'approved')", [id++, mode]);
      assert.equal(await balance(), 815067);
      assert.equal(await reserved(), 0);
    }
    await db.query("INSERT INTO expenses(id,site_id,created_by,debit,status) VALUES (99,5,7,710,'approved')");
    assert.equal(await balance(), 815067, 'admin expense must not charge staff');
    await db.query('SAVEPOINT insufficient');
    await assert.rejects(db.query("INSERT INTO expenses(id,site_id,created_by,debit,status) VALUES (100,5,12,900000,'approved')"), error => error.constraint === 'imprest_sufficient_balance');
    await db.query('ROLLBACK TO SAVEPOINT insufficient');
    assert.equal((await db.query('SELECT COUNT(*)::int AS n FROM expenses WHERE id=100')).rows[0].n, 0);
    assert.equal(await balance(), 815067);
  } finally {
    await db.query('ROLLBACK');
    db.release();
    await pool.end();
  }
});
