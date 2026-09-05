import test from 'node:test';
import assert from 'node:assert/strict';
import pool from '../src/config/db.js';
import { up } from '../src/migrations/148_transaction_time.js';
import { TRANSACTION_TIME_TABLES } from '../src/services/transactionTime.service.js';
import balanceSheet from '../src/models/BalanceSheet.model.js';

test('migration preserves legacy times and synchronizes native, linked and personal rows atomically', { skip: process.env.TRANSACTION_TIME_DB_TESTS !== '1' }, async () => {
  let statementSql;
  let calls = 0;
  const query = pool.query;
  pool.query = async sql => { if (++calls === 2) statementSql = sql; return { rows: calls === 1 ? [{ report: {} }] : [] }; };
  try { await balanceSheet.getReport({ siteId: 999 }); } finally { pool.query = query; }
  const sort = statementSql.slice(statementSql.lastIndexOf('  ORDER BY'), statementSql.indexOf('  LIMIT $9::int'));
  const db = await pool.connect();
  const schema = `transaction_time_test_${process.pid}`;
  try {
    await db.query('BEGIN');
    // All fixtures, functions, triggers and schema changes are rolled back.
    // No application tables, financial records or sequences are modified.
    await db.query(`CREATE SCHEMA ${schema}`);
    await db.query(`SET LOCAL search_path TO ${schema}`);
    await db.query('CREATE TABLE app_schema_migrations (version text PRIMARY KEY)');
    for (const table of TRANSACTION_TIME_TABLES) {
      await db.query(`CREATE TABLE ${table} (id integer PRIMARY KEY, amount numeric DEFAULT 100,
        source_module text, source_id integer, source_plot_payment_id integer, source_vendor_payment_id integer)`);
      await db.query(`INSERT INTO ${table}(id) VALUES (1)`);
    }
    const adapter = { connect: async () => ({
      query: (sql, args) => ['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql) ? Promise.resolve({ rows: [] }) : db.query(sql, args),
      release() {},
    }) };
    await up(adapter);
    await up(adapter); // Safe on every backend start.
    for (const table of TRANSACTION_TIME_TABLES) {
      assert.equal((await db.query(`SELECT transaction_time FROM ${table} WHERE id=1`)).rows[0].transaction_time, null);
      const added = (await db.query(`INSERT INTO ${table}(id) VALUES (2) RETURNING transaction_time`)).rows[0];
      assert.match(added.transaction_time, /^\d{2}:\d{2}:\d{2}$/);
    }
    await db.query(`WITH source AS (
      INSERT INTO plot_payments (id, transaction_time) VALUES (3, '09:15:27') RETURNING id
    ) INSERT INTO cash_flow_entries (id, source_module, source_id)
      SELECT 3, 'plot_payments', id FROM source`);
    await db.query(`INSERT INTO cash_flow_entries (id, source_module, source_id) VALUES
      (4, 'plot_payments_person', 3), (5, 'plot_payments', 1)`);
    await db.query(`INSERT INTO plot_registry_payments (id, source_plot_payment_id) VALUES (3,3),(4,1)`);
    const time = async (table, id) => (await db.query(`SELECT transaction_time FROM ${table} WHERE id=$1`, [id])).rows[0].transaction_time;
    for (const id of [3, 4]) assert.equal(await time('cash_flow_entries', id), '09:15:27');
    assert.equal(await time('cash_flow_entries', 5), null);
    assert.equal(await time('plot_registry_payments', 3), '09:15:27');
    assert.equal(await time('plot_registry_payments', 4), null);
    await db.query(`UPDATE plot_payments SET transaction_time='00:00:01' WHERE id=3`);
    for (const id of [3, 4]) assert.equal(await time('cash_flow_entries', id), '00:00:01');
    assert.equal(await time('plot_registry_payments', 3), '00:00:01');
    await db.query(`UPDATE plot_payments SET transaction_time=NULL WHERE id=3`);
    assert.equal(await time('cash_flow_entries', 3), null);
    assert.equal(await time('plot_registry_payments', 3), null);
    await db.query(`UPDATE vendor_payments SET transaction_time='17:45:09' WHERE id=2`);
    await db.query(`INSERT INTO vendor_inventory_payments (id, source_vendor_payment_id) VALUES (3,2)`);
    assert.equal(await time('vendor_inventory_payments', 3), '17:45:09');
    for (const table of TRANSACTION_TIME_TABLES) {
      assert.equal((await db.query(`SELECT COUNT(*)::int AS n FROM ${table} WHERE amount<>100`)).rows[0].n, 0);
    }
    const ordered = await db.query(`WITH period_entries(id,entry_date,display_position,global_display_position,transaction_time,created_at) AS (VALUES
      ('older-day', '2026-08-31'::date, 1, 1, '23:59:59'::time, '2026-09-05'::timestamp),
      ('manual-second', '2026-09-05'::date, 2, NULL, '18:30:00'::time, '2026-09-05'::timestamp),
      ('manual-first', '2026-09-05'::date, 1, NULL, '09:00:00'::time, '2026-09-05'::timestamp),
      ('later-time', '2026-09-05'::date, NULL, NULL, '22:00:02'::time, '2026-09-05'::timestamp),
      ('earlier-time', '2026-09-05'::date, NULL, NULL, '22:00:01'::time, '2026-09-05'::timestamp),
      ('midnight', '2026-09-05'::date, NULL, NULL, '00:00:00'::time, '2026-09-05'::timestamp),
      ('unknown-time', '2026-09-05'::date, NULL, NULL, NULL::time, '2026-09-05'::timestamp))
      SELECT * FROM period_entries ${sort}`);
    assert.deepEqual(ordered.rows.map(row => row.id), ['manual-first', 'manual-second', 'later-time', 'earlier-time', 'midnight', 'unknown-time', 'older-day']);
  } finally {
    await db.query('ROLLBACK');
    db.release();
    await pool.end();
  }
});
