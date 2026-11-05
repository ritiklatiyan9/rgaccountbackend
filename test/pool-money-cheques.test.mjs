import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { poolMoneySql } from '../src/migrations/238_pool_money.js';
import { approvePoolMoneyReceipt } from '../src/services/poolMoneyReceipt.service.js';
import { updateChequeStatusRecord } from '../src/services/chequeStatus.service.js';
import { loadPendingChequeCandidates } from '../src/services/chequeMatching.service.js';

const admin = { id: 1, role: 'admin', organization_id: 1 };
async function fixture(t) {
  const db = new PGlite(); t.after(() => db.close());
  await db.exec(`CREATE TABLE sites(id int PRIMARY KEY,organization_id int); INSERT INTO sites VALUES(1,1),(2,2);
    CREATE TABLE users(id int PRIMARY KEY); INSERT INTO users VALUES(1);
    CREATE TABLE plot_payments(id int PRIMARY KEY);
    CREATE TABLE cash_flow_months(id int PRIMARY KEY,is_locked boolean DEFAULT false); INSERT INTO cash_flow_months VALUES(1,false);
    CREATE TABLE cash_flow_entries(id serial PRIMARY KEY,cash_flow_month_id int,site_id int,date date,particular text,debit numeric,credit numeric,
      cash_type text,remarks text,status text,source_module text,source_id int,created_by int,created_at timestamptz,updated_at timestamptz,
      cheque_no text,cheque_status text,bank_account_id int,approved_by int,approved_at timestamptz,assigned_admin_id int,cheque_transaction_date date,
      UNIQUE(source_module,source_id));
    CREATE FUNCTION ensure_site_cashflow_month(integer,date,integer) RETURNS integer LANGUAGE sql AS 'SELECT 1';
    ${poolMoneySql}
    INSERT INTO pool_money_receipts(source_kind,source_id,owner_id,site_id,reference,amount,date,payment_from,payment_type,cheque_no,cheque_status,created_by)
      VALUES('draw',10,5,1,'DP-001',100000,'2026-11-05','CHEQUE','CHEQUE','CH-001','PENDING',1);`);
  return { db, pool: { connect: async () => ({ query: (...args) => db.query(...args), release() {} }) } };
}

test('pool cheque clearance and separate approval preserve receipt identity and original amounts', async t => {
  const { db, pool } = await fixture(t);
  const identity = { receiptId: 1, siteId: 1, expectedAmount: 100000 };
  await assert.rejects(approvePoolMoneyReceipt(pool, admin, identity), { code: 'CHEQUE_CLEARANCE_REQUIRED' });
  await assert.rejects(updateChequeStatusRecord(db, { source: 'pool_money_receipt', entryId: 1, status: 'CLEARED', requireTransactionDate: true }), { code: 'CHEQUE_TRANSACTION_DATE_REQUIRED' });
  const changed = await updateChequeStatusRecord(db, { source: 'pool_money_receipt', entryId: 1, status: 'CLEARED',
    chequeTransactionDate: '2026-11-06', expectedSiteId: 1, expectedAmount: 100000, requireTransactionDate: true });
  assert.equal(changed.after.status, 'pending', 'bank clearance does not approve the collection');
  const result = await approvePoolMoneyReceipt(pool, admin, identity);
  assert.equal(result.receipt.status, 'approved');
  const { rows: [ledger] } = await db.query("SELECT *,to_char(date,'YYYY-MM-DD') AS original_date,to_char(cheque_transaction_date,'YYYY-MM-DD') AS clearance_date FROM cash_flow_entries");
  assert.equal(ledger.id, 1); assert.equal(Number(ledger.credit), 100000); assert.equal(ledger.status, 'approved');
  assert.equal(ledger.cheque_status, 'CLEARED'); assert.equal(ledger.clearance_date, '2026-11-06');
  assert.equal(ledger.original_date, '2026-11-05');
  assert.equal((await db.query('SELECT count(*)::int AS n FROM pool_money_events')).rows[0].n, 1);
  await assert.rejects(approvePoolMoneyReceipt(pool, admin, identity), { code: 'POOL_RECEIPT_ALREADY_DECIDED' });
  assert.equal((await db.query('SELECT count(*)::int AS n FROM cash_flow_entries')).rows[0].n, 1);
});

test('pool receipt decisions reject stale amounts, foreign sites and locked periods without updates', async t => {
  const { db, pool } = await fixture(t);
  const input = { receiptId: 1, siteId: 1, expectedAmount: 100000 };
  await assert.rejects(approvePoolMoneyReceipt(pool, { ...admin, role: 'sub_admin' }, input), { statusCode: 403 });
  await assert.rejects(approvePoolMoneyReceipt(pool, { ...admin, organization_id: 2 }, input), { code: 'POOL_RECEIPT_NOT_FOUND' });
  await assert.rejects(approvePoolMoneyReceipt(pool, admin, { ...input, expectedAmount: 90000 }), { code: 'POOL_RECEIPT_AMOUNT_CHANGED' });
  await db.exec('UPDATE cash_flow_months SET is_locked=true');
  await assert.rejects(approvePoolMoneyReceipt(pool, admin, input), { code: 'ACCOUNTING_PERIOD_LOCKED' });
  await assert.rejects(updateChequeStatusRecord(db, { source: 'pool_money_receipt', entryId: 1, status: 'BOUNCED', expectedSiteId: 1 }), { code: 'ACCOUNTING_PERIOD_LOCKED' });
  assert.equal((await db.query('SELECT status FROM pool_money_receipts')).rows[0].status, 'pending');
  assert.equal((await db.query('SELECT count(*)::int AS n FROM pool_money_events')).rows[0].n, 0);
});

test('matcher recognises pool source without requiring its table on older installations', async () => {
  let sql;
  const rows = await loadPendingChequeCandidates({ query: async text => { sql = text; return { rows: [
    { source: 'pool_money_receipt', entry_id: 1, ledger_id: 3, amount: '100000', aliases: [] },
  ] }; } }, 1, 1);
  assert.match(sql, /WHEN 'pool_money_receipts' THEN 'pool_money_receipt'/);
  assert.match(sql, /'plot_installment_payments', 'pool_money_receipts'/);
  assert.doesNotMatch(sql, /JOIN pool_money_receipts/);
  assert.equal(rows[0].source, 'pool_money_receipt');
});

test('real reconciliation query discovers one pool cheque and respects organization and status filters', async t => {
  const { db } = await fixture(t);
  await db.exec(`ALTER TABLE cash_flow_entries ADD COLUMN transaction_time time,ADD COLUMN to_name text;
    ALTER TABLE plot_payments ADD COLUMN plot_id int,ADD COLUMN cheque_no text,ADD COLUMN cheque_status text,ADD COLUMN buyer_name text,ADD COLUMN booked_by text;
    CREATE TABLE bank_accounts(id int,name text,account_no text);
    CREATE TABLE plot_commissions(id int,cheque_status text,cheque_no text);
    CREATE TABLE farmer_payments(id int,farmer_id int,cheque_status text,cheque_no text);
    CREATE TABLE farmers(id int,name text);
    CREATE TABLE plots(id int,buyer_name text,booking_by text,plot_no text);
    CREATE TABLE plot_installment_payments(id int,plot_id int,cheque_status text,cheque_no text);
    CREATE TABLE plot_commission_payments(id int,plot_commission_id int,cheque_status text,cheque_no text);
    CREATE TABLE plot_commissions_v2(id int);
    CREATE TABLE vendor_payments(id int,commitment_id int,cheque_status text,cheque_no text);
    CREATE TABLE vendor_commitments(id int,vendor_name text);
    CREATE TABLE vendor_inventory_payments(id int,order_id int,source_vendor_payment_id int,cheque_status text,cheque_no text);
    CREATE TABLE vendor_inventory_orders(id int,vendor_name text);
    CREATE TABLE plot_registry_payments(id int,registry_id int,source_plot_payment_id int,cheque_status text,cheque_no text);
    CREATE TABLE plot_registries(id int,customer_name text,plot_no text);
    CREATE TABLE land_deal_payments(id int,land_deal_id int,cheque_status text,cheque_no text);
    CREATE TABLE land_deals(id int,buyer_name text);
    CREATE TABLE misc_income_entries(id int,party_name text,cheque_status text,cheque_no text);
    CREATE TABLE firm_transactions(id int,firm_id int,name text,cheque_status text,cheque_no text);
    CREATE TABLE expenses(id int,remark text,to_entity text,from_entity text,cheque_status text,cheque_no text);
    CREATE TABLE day_book(id int,particular text,to_entity text,from_entity text,cheque_status text,cheque_no text,is_financial_projection boolean,
      farmer_payment_id int,commission_id int,cash_flow_entry_id int,firm_transaction_id int,plot_payment_id int,vendor_payment_id int);
    CREATE TABLE bank_reconciliation_candidate_metadata(organization_id int,site_id int,entity_source text,entity_entry_id int,
      payer_names jsonb,booking_reference text,plot_reference text,account_suffix text);
    CREATE TABLE bank_reconciliation_aliases(organization_id int,site_id int,entity_source text,entity_entry_id int,alias_value text);`);
  const entries = await loadPendingChequeCandidates(db, 1, 1);
  assert.equal(entries.length, 1); assert.equal(entries[0].source, 'pool_money_receipt');
  assert.equal(entries[0].cheque_no, 'CH-001'); assert.equal(Number(entries[0].amount), 100000);
  assert.deepEqual(await loadPendingChequeCandidates(db, 2, 1), []);
  assert.deepEqual(await loadPendingChequeCandidates(db, 1, 1, 'CLEARED'), []);
  await updateChequeStatusRecord(db, { source: 'pool_money_receipt', entryId: 1, status: 'CLEARED', chequeTransactionDate: '2026-11-06' });
  assert.deepEqual(await loadPendingChequeCandidates(db, 1, 1), []);
  const cleared = await loadPendingChequeCandidates(db, 1, 1, 'CLEARED');
  assert.equal(cleared.length, 1); assert.equal(cleared[0].cheque_transaction_date, '2026-11-06');
});
