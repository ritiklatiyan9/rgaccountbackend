import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { up, VOUCHER_GAP_TABLES } from '../src/migrations/196_existing_voucher_gaps_filled.js';

test('voucher baseline covers all sites once, preserves financial records, and never fills future backdated entries', async () => {
  const db = new PGlite();
  const pool = { connect: async () => ({ query: (sql, params) => db.query(sql, params), release() {} }) };
  try {
    await db.query(`CREATE FUNCTION forbid_financial_updates() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'Baseline must not update financial records'; END $$`);
    for (const table of VOUCHER_GAP_TABLES) {
      await db.query(`CREATE TABLE ${table} (id INTEGER PRIMARY KEY, site_id INTEGER, date DATE,
        status TEXT, amount NUMERIC, voucher_url TEXT, created_at TIMESTAMPTZ DEFAULT now())`);
      await db.query(`INSERT INTO ${table} (id,site_id,date,status,amount,voucher_url) VALUES
        (1,1,'2020-01-01','approved',500,NULL), (2,8,'2020-01-01','pending',750,'https://example.com/voucher.pdf')`);
      await db.query(`CREATE TRIGGER no_financial_update BEFORE UPDATE ON ${table}
        FOR EACH ROW EXECUTE FUNCTION forbid_financial_updates()`);
    }
    const baselineAt = await up(pool);
    assert.ok(baselineAt);
    for (const table of VOUCHER_GAP_TABLES) {
      const { rows } = await db.query(`SELECT * FROM ${table} ORDER BY id`);
      assert.equal(new Date(rows[0].voucher_gap_filled_at).toISOString(), baselineAt);
      assert.equal(new Date(rows[1].voucher_gap_filled_at).toISOString(), baselineAt);
      assert.deepEqual(rows.map(({ site_id, status, amount, voucher_url }) => ({ site_id, status, amount, voucher_url })), [
        { site_id: 1, status: 'approved', amount: '500', voucher_url: null },
        { site_id: 8, status: 'pending', amount: '750', voucher_url: 'https://example.com/voucher.pdf' },
      ]);
      await db.query(`INSERT INTO ${table} (id,site_id,date,status,amount) VALUES (3,8,'2020-01-01','pending',900)`);
    }
    await up(pool);
    for (const table of VOUCHER_GAP_TABLES) {
      const { rows } = await db.query(`SELECT voucher_gap_filled_at FROM ${table} WHERE id=3`);
      assert.equal(rows[0].voucher_gap_filled_at, null, `${table}: new entry must remain unfilled after a restart`);
    }
    assert.equal((await db.query('SELECT COUNT(*) AS count FROM app_schema_migrations')).rows[0].count, 1);
  } finally {
    await db.close();
  }
});
