import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { attachDayBookTds } from '../src/services/daybookTds.service.js';

test('mixed-owner TDS snapshots need one query and keep source net/gross and identity data', async () => {
  const db = new PGlite();
  try {
    for (const table of ['expenses', 'farmer_payments', 'cash_flow_entries', 'plot_commission_payments']) {
      await db.exec(`CREATE TABLE ${table}(id int PRIMARY KEY, debit numeric, amount numeric,
        plot_commission_id int, tds_amount numeric, tds_rate numeric, tds_mode text, tds_section text,
        tds_module text, tds_member_id int, tds_deductee_name text, tds_pan text, tds_aadhaar text);
        INSERT INTO ${table} VALUES(1,980,980,1,20,2,'percentage','194C','fixture',7,'Original name','Original PAN','Original Aadhaar');`);
    }
    await db.exec(`CREATE TABLE plot_commissions_v2(id int PRIMARY KEY, plot_id int, farmer_id int);
      INSERT INTO plot_commissions_v2 VALUES(1,1,NULL),(2,NULL,1),(3,NULL,NULL);
      INSERT INTO plot_commission_payments(id,amount,plot_commission_id,tds_amount) VALUES(2,1900,2,100),(3,475,3,25);`);
    let queries = 0;
    const tracked = { query: (...args) => { queries++; return db.query(...args); } };
    const entries = [
      { id: 'expense_1', expense_id: 1 }, { id: 'fp_1', farmer_payment_id: 1 },
      { id: 'cf_1', cash_flow_entry_id: 1 },
      { id: '1:cash', source_key: 'plot_commission_payments', source_id: 1, entry_date: '2026-01-01' },
      { id: '1:bank', source_key: 'plot_commission_payments', source_id: 1, entry_date: '2026-01-01' },
      { id: '2:cash', source_key: 'plot_commission_payments', source_id: 2 },
      { id: '3:cash', source_key: 'plot_commission_payments', source_id: 3 },
      { id: 'unknown_1', source_key: 'untrusted_source', source_id: 1 },
    ];
    assert.equal(await attachDayBookTds(entries, tracked), entries);
    assert.equal(queries, 1, 'four source tables share one database statement');
    for (const entry of entries.slice(0, 5)) {
      assert.equal(entry.net_amount, 980);
      assert.equal(entry.gross_amount, 1000);
      assert.equal(entry.tds_metadata_scope, 'source_payment');
      assert.equal(entry.tds_deductee_name, 'Original name');
      assert.equal(entry.tds_pan, 'Original PAN');
      assert.equal(entry.tds_aadhaar, 'Original Aadhaar');
    }
    assert.equal(entries[3].tds_module, 'plot_commission');
    assert.equal(entries[5].tds_module, 'land_purchase_commission');
    assert.equal(entries[6].tds_module, 'land_sale_commission');
    assert.equal(entries[5].gross_amount, 2000);
    assert.equal(entries[6].gross_amount, 500);
    assert.equal(entries[7].tds_amount, undefined);
    assert.deepEqual(await attachDayBookTds([], tracked), []);
    assert.equal(queries, 1);
  } finally { await db.close(); }
});
