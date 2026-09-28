import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decorateRegistryStage } from '../src/utils/registryStage.js';
import { plotRegistryModel } from '../src/models/PlotRegistry.model.js';

test('RO decoration uses manual cash and linked bank without any receipts fallback', () => {
  const row = { registry_payment: '1415160', total_paid: '4807500', bank_paid: '1652000', ro_cash_amount: null, ro_bank_amount: '9999999' };
  const result = decorateRegistryStage(row);
  assert.equal(result.ro_cash, 0);
  assert.equal(result.ro_bank, 1652000);
  assert.equal(result.ro_total, 1652000);
  assert.equal(result.ro_diff, 236840);
  assert.equal(result.ro_manual, false);
  assert.equal(decorateRegistryStage({ ...row, ro_cash_amount: '50000' }).ro_total, 1702000);
  assert.equal(decorateRegistryStage({ total_paid: 3155500, ro_bank_amount: 50000 }).ro_set, false);
  assert.equal(decorateRegistryStage({ ro_cash_amount: 0 }).ro_set, true);
});

test('registry list and detail agree on manual cash plus live linked bank', { skip: !process.env.PGLITE_MODULE }, async () => {
  const { PGlite } = await import(process.env.PGLITE_MODULE);
  const db = new PGlite();
  const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
  try {
    await db.exec(`
      CREATE TABLE plot_registries(id int PRIMARY KEY, site_id int, plot_id int, plot_no text, customer_name text,
        size_meter numeric, size_sqyard numeric, registry_payment numeric, circle_rate numeric, registry_date date,
        farmer_name text, assigned_admin_id int, noc_farmer_member_ids int[], noc_farmer_member_id int,
        ro_cash_amount numeric, ro_bank_amount numeric);
      CREATE TABLE plots(id int PRIMARY KEY, site_id int, plot_no text, buyer_name text, plot_size numeric, plot_size_mtr numeric,
        unit_type text, team text, booking_by text, plot_tag text, status text, co_applicant_name text,
        co_applicant_relation text, co_applicant_phone text, co_applicant_aadhar text, co_applicant_pan text);
      CREATE TABLE users(id int PRIMARY KEY, name text);
      CREATE TABLE members(id int PRIMARY KEY, site_id int, full_name text);
      CREATE TABLE documents(id int PRIMARY KEY, plot_id int, category text, uploaded_source text);
      CREATE TABLE plot_payments(id int PRIMARY KEY, plot_id int, amount numeric, payment_type text, status text, cheque_status text);
      CREATE TABLE plot_registry_payments(id int PRIMARY KEY, registry_id int, source_plot_payment_id int,
        amount numeric, payment_mode text, status text DEFAULT 'approved', cheque_status text, created_by int);
      INSERT INTO plots(id, site_id, plot_no, buyer_name, plot_size, plot_size_mtr, unit_type, plot_tag, status)
        VALUES (444,5,'A53','TEST',169.2,141.516,'plot','NEW','REGISTRY'),(445,5,'OTHER','TEST',100,83.64,'plot','NEW','REGISTRY');
      INSERT INTO plot_registries(id, site_id, plot_id, plot_no, registry_payment, ro_bank_amount)
        VALUES (703,5,444,'A53',1415160,9999999);
      INSERT INTO plot_payments VALUES
        (1,444,500000,'BANK','approved',NULL),(2,444,500000,'BANK','approved',NULL),(3,444,652000,'BANK','approved',NULL),
        (4,444,3155500,'CASH','approved',NULL),(5,445,999999,'BANK','approved',NULL),
        (6,444,999999,'BANK','rejected',NULL),(7,444,2500,'CHEQUE','approved','PENDING');
      INSERT INTO plot_registry_payments(id,registry_id,source_plot_payment_id,amount,payment_mode,created_by) VALUES
        (1,703,1,500000,'BANK',1),(2,703,2,500000,'BANK',2),(3,703,3,652000,'BANK',2),
        (4,703,4,3155500,'CASH',1),(5,703,5,999999,'BANK',1),(6,703,6,999999,'BANK',1),
        (7,703,7,2500,'CHEQUE',1),(8,703,NULL,900000,'BANK',1),(9,703,NULL,50000,'CASH',1);
    `);
    await db.exec(read('../src/migrations/118_credit_first_posting.js').match(/CREATE OR REPLACE FUNCTION financial_transaction_posts\([\s\S]+?\$\$\s*`/)[0].slice(0, -1));
    await db.exec(read('../src/migrations/079_ledger_entries_view.js').match(/CREATE FUNCTION ledger_bucket\(raw text\)[\s\S]+?\$fn\$;/)[0]);
    const pool = { query: (sql, params) => db.query(sql, params) };
    const receiptsBefore = (await db.query('SELECT * FROM plot_payments ORDER BY id')).rows;
    const linksBefore = (await db.query('SELECT * FROM plot_registry_payments ORDER BY id')).rows;
    const check = async (cash, bank, creator = null) => {
      const list = await plotRegistryModel.findBySiteId(5, pool, creator);
      const detail = await plotRegistryModel.findByIdWithTotals(703, pool, creator);
      for (const row of [list[0], detail]) {
        assert.equal(Number(row.total_paid), cash + bank);
        assert.equal(Number(row.bank_paid), bank);
        assert.equal(row.ro_cash, cash);
        assert.equal(row.ro_bank, bank);
        assert.equal(row.ro_total, cash + bank);
      }
    };
    await check(0, 1652000);
    await check(0, 500000, '1');
    assert.deepEqual((await db.query('SELECT * FROM plot_payments ORDER BY id')).rows, receiptsBefore);
    assert.deepEqual((await db.query('SELECT * FROM plot_registry_payments ORDER BY id')).rows, linksBefore);
    await db.exec('UPDATE plot_registries SET ro_cash_amount=50000 WHERE id=703');
    await check(50000, 1652000);
    await db.exec('UPDATE plot_payments SET amount=752000 WHERE id=3');
    await check(50000, 1752000);
    await db.exec("UPDATE plot_payments SET cheque_status='CLEARED' WHERE id=7");
    await check(50000, 1754500);
    await db.exec('DELETE FROM plot_registry_payments WHERE id=3');
    await check(50000, 1002500);
    await db.exec('UPDATE plot_registries SET ro_cash_amount=NULL WHERE id=703');
    await check(0, 1002500);
  } finally { await db.close(); }
});
