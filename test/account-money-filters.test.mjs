import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
test('plot filter aggregates distinguish registry bank coverage and unregistered advances', { skip: !process.env.PGLITE_MODULE }, async () => {
  const { PGlite } = await import(process.env.PGLITE_MODULE);
  const db = new PGlite();
  try {
    await db.exec(`
      CREATE TABLE plots(id int, site_id int, plot_no text, plot_tag text, booking_date date);
      CREATE TABLE plot_registries(id int, site_id int, plot_id int, plot_no text);
      CREATE TABLE plot_payments(id int, plot_id int, amount numeric, payment_type text, status text,
        cheque_status text, buyer_name text, booked_by text, created_by int);
      CREATE TABLE plot_installment_payments(plot_id int, amount numeric, payment_mode text, status text, cheque_status text, created_by int);
      CREATE TABLE plot_registry_payments(id int, registry_id int, source_plot_payment_id int,
        amount numeric, payment_mode text, status text, cheque_status text, created_by int);
      INSERT INTO plots VALUES (1,10,'A1',NULL,NULL),(2,10,'A2',NULL,NULL),(3,10,'A3',NULL,NULL),
        (4,10,'A4','OLD',NULL),(5,10,'A4','NEW',NULL),(6,10,'A5',NULL,NULL),(7,20,'A1',NULL,NULL);
      INSERT INTO plot_registries VALUES (11,10,1,'A1'),(12,10,2,'A2'),(14,10,NULL,'A4'),(17,20,7,'A1');
      INSERT INTO plot_payments VALUES
        (101,1,100,'BANK','approved',NULL,NULL,NULL,9),
        (102,1,40,'CASH','approved',NULL,NULL,NULL,9),
        (103,1,500,'CHEQUE','approved','PENDING',NULL,NULL,9),
        (104,1,60,'CHEQUE','approved','CLEARED',NULL,NULL,9),
        (105,3,200,'BANK','approved',NULL,NULL,NULL,9),
        (106,1,800,'BANK','rejected',NULL,NULL,NULL,9);
      INSERT INTO plot_installment_payments VALUES (6,80,'UPI','approved',NULL,9);
      INSERT INTO plot_registry_payments VALUES
        (201,11,101,100,'CASH','approved',NULL,9),
        (202,11,102,40,'BANK','approved',NULL,9),
        (203,11,103,500,'CHEQUE','approved','PENDING',9),
        (204,11,104,60,'CHEQUE','approved','CLEARED',9),
        (205,11,105,200,'BANK','approved',NULL,9),
        (206,11,106,800,'BANK','approved',NULL,9),
        (207,11,NULL,25,'UPI','pending',NULL,9),
        (208,11,NULL,900,'BANK','rejected',NULL,9),
        (209,12,NULL,50,'CASH','approved',NULL,9),
        (210,17,NULL,700,'BANK','approved',NULL,9);
    `);
    await db.exec(read('../src/migrations/079_ledger_entries_view.js').match(/CREATE FUNCTION ledger_bucket\(raw text\)[\s\S]+?\$fn\$;/)[0]);
    const policy = read('../src/migrations/171_cheque_clearance_before_approval.js').match(/export const postingPolicySql = `([\s\S]+?)`;/)[1];
    await db.exec(policy);
    const source = read('../src/graphql/services/plotPayments.service.js');
    const query = source.match(/const query = `([\s\S]+?)`;/)[1];
    const sql = vm.runInNewContext('`' + query + '`', {
      PP_POSTS: "financial_transaction_posts('credit', pp.status, pp.payment_type, pp.cheque_status)",
      PIP_POSTS: "financial_transaction_posts('credit', pip.status, pip.payment_mode, pip.cheque_status)",
      PLOT_BUYER_KYC_STATUS: 'NULL', PLOT_BUYER_KYC_JOIN: '',
      PLOT_BUYER_MEMBER_JOIN: 'LEFT JOIN LATERAL (SELECT NULL::int AS id) plot_buyer ON TRUE',
    });
    const rows = (await db.query(sql, [10,null])).rows;
    const byId = new Map(rows.map(row => [row.id,row]));
    assert.equal(rows.length, 6, 'other sites stay excluded');
    assert.equal(Number(byId.get(1).registry_bank_received), 185, 'use linked instrument; exclude foreign plot, rejected and uncleared receipts');
    assert.equal(byId.get(1).has_registry, true);
    assert.equal(Number(byId.get(2).registry_bank_received), 0, 'cash-only registry has no bank coverage');
    assert.equal(byId.get(2).has_registry, true);
    assert.equal(byId.get(3).has_registry, false);
    assert.equal(Number(byId.get(3).received_bank), 200);
    assert.equal(byId.get(4).has_registry, false, 'legacy plot-number fallback must not attach an OLD booking');
    assert.equal(byId.get(5).has_registry, true);
    assert.equal(byId.get(6).has_registry, false);
    assert.equal(Number(byId.get(6).received_bank), 80, 'bank installments remain advances before registry');
    const scoped = (await db.query(sql, [10,99])).rows;
    assert.ok(scoped.every(row => Number(row.registry_bank_received) === 0 && Number(row.total_received) === 0));
  } finally { await db.close(); }
});
