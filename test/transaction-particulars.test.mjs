import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { attachTransactionParticulars } from '../src/services/transactionParticulars.service.js';

test('owner metadata resolves every module in one query without changing the money or source records', async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      CREATE TABLE expenses (id int PRIMARY KEY, debit numeric, credit numeric, from_entity text, to_entity text, category text, sub_category text);
      INSERT INTO expenses VALUES (1, 900, 0, 'OM ASSOCIATES', 'Employee', 'SALARY', 'SITE STAFF'), (2, 0, 100, 'Refund payer', 'OM ASSOCIATES', 'REFUND', NULL);
      CREATE TABLE day_book (id int PRIMARY KEY, debit numeric, from_entity text, to_entity text, category text);
      INSERT INTO day_book VALUES (1, 0, 'Sender', 'Recipient', 'TRANSFER');
      CREATE TABLE cash_flow_months (id int PRIMARY KEY, ledger_name text, ledger_type text);
      INSERT INTO cash_flow_months VALUES (1, 'BALAJI ASSOCIATES', 'person');
      CREATE TABLE cash_flow_entries (id int PRIMARY KEY, cash_flow_month_id int, to_name text);
      INSERT INTO cash_flow_entries VALUES (1, 1, NULL);
      CREATE TABLE farmers (id int PRIMARY KEY, name text);
      INSERT INTO farmers VALUES (1, 'Farmer');
      CREATE TABLE farmer_payments (id int PRIMARY KEY, farmer_id int);
      INSERT INTO farmer_payments VALUES (1, 1);
      CREATE TABLE plots (id int PRIMARY KEY, buyer_name text);
      INSERT INTO plots VALUES (1, 'Current buyer');
      CREATE TABLE plot_payments (id int PRIMARY KEY, plot_id int, buyer_name text);
      INSERT INTO plot_payments VALUES (1, 1, 'Original buyer');
      CREATE TABLE plot_installment_payments (id int PRIMARY KEY, plot_id int);
      INSERT INTO plot_installment_payments VALUES (1, 1);
      CREATE TABLE plot_registries (id int PRIMARY KEY, customer_name text);
      INSERT INTO plot_registries VALUES (1, 'Registry customer');
      CREATE TABLE plot_registry_payments (id int PRIMARY KEY, registry_id int);
      INSERT INTO plot_registry_payments VALUES (1, 1);
      CREATE TABLE plot_commissions (id int PRIMARY KEY, particular text);
      INSERT INTO plot_commissions VALUES (1, 'Legacy agent');
      CREATE TABLE members (id int PRIMARY KEY, full_name text);
      INSERT INTO members VALUES (1, 'Agent'), (2, 'Partner');
      CREATE TABLE plot_commissions_v2 (id int PRIMARY KEY, agent_id int, plot_id int, farmer_id int);
      INSERT INTO plot_commissions_v2 VALUES (1, 1, 1, NULL), (2, 1, NULL, 1), (3, 1, NULL, NULL);
      CREATE TABLE plot_commission_payments (id int PRIMARY KEY, plot_commission_id int);
      INSERT INTO plot_commission_payments VALUES (1, 1), (2, 2), (3, 3);
      CREATE TABLE firms (id int PRIMARY KEY, name text);
      INSERT INTO firms VALUES (1, 'Firm');
      CREATE TABLE firm_transactions (id int PRIMARY KEY, firm_id int);
      INSERT INTO firm_transactions VALUES (1, 1);
      CREATE TABLE vendor_commitments (id int PRIMARY KEY, vendor_name text);
      INSERT INTO vendor_commitments VALUES (1, 'Contractor');
      CREATE TABLE vendor_payments (id int PRIMARY KEY, commitment_id int);
      INSERT INTO vendor_payments VALUES (1, 1);
      CREATE TABLE vendor_inventory_orders (id int PRIMARY KEY, vendor_name text, item_category text);
      INSERT INTO vendor_inventory_orders VALUES (1, 'Supplier', 'BRICKS');
      CREATE TABLE vendor_inventory_payments (id int PRIMARY KEY, order_id int);
      INSERT INTO vendor_inventory_payments VALUES (1, 1);
      CREATE TABLE land_deals (id int PRIMARY KEY, buyer_name text);
      INSERT INTO land_deals VALUES (1, 'Land buyer');
      CREATE TABLE land_deal_payments (id int PRIMARY KEY, land_deal_id int);
      INSERT INTO land_deal_payments VALUES (1, 1);
      CREATE TABLE misc_income_categories (id int PRIMARY KEY, name text);
      INSERT INTO misc_income_categories VALUES (1, 'Maintenance');
      CREATE TABLE misc_income_entries (id int PRIMARY KEY, category_id int, party_name text);
      INSERT INTO misc_income_entries VALUES (1, 1, 'Resident');
      CREATE TABLE partner_profit_payments (id int PRIMARY KEY, member_id int);
      INSERT INTO partner_profit_payments VALUES (1, 2);
      CREATE TABLE transaction_party_links (source_key text, source_id int, site_id int, member_id int, PRIMARY KEY(source_key, source_id));
      INSERT INTO transaction_party_links VALUES ('expense', 1, 1, 2), ('expense', 2, 2, 2);
    `);
    for (const table of ['expenses', 'day_book', 'cash_flow_entries', 'farmer_payments', 'plot_payments', 'plot_installment_payments', 'plot_registry_payments', 'plot_commissions', 'plot_commission_payments', 'firm_transactions', 'vendor_payments', 'vendor_inventory_payments', 'land_deal_payments', 'misc_income_entries', 'partner_profit_payments']) {
      await db.exec(`ALTER TABLE ${table} ADD COLUMN site_id int DEFAULT 1`);
    }
    const expected = { expenses: 'Employee', day_book: 'Sender', personal_ledger: 'BALAJI ASSOCIATES', farmer_payments: 'Farmer', plot_payments: 'Original buyer', plot_installment_payments: 'Current buyer', plot_registry_payments: 'Registry customer', plot_commissions: 'Legacy agent', plot_commission_payments: 'Agent', firm_transactions: 'Firm', vendor_payments: 'Contractor', vendor_inventory_payments: 'Supplier', land_deal_payments: 'Land buyer', misc_income_entries: 'Resident', partner_profit_payments: 'Partner' };
    const entries = Object.keys(expected).map((source, index) => ({
      ...(index % 2 ? { order_key: `${source}:1` } : { source_key: source, source_id: source === 'personal_ledger' ? null : 1, id: '1:cash' }),
      particular: 'Generated narration', debit: '900', credit: '0', status: 'approved',
    }));
    const original = structuredClone(entries);
    let calls = 0;
    const queryable = { query: async (...args) => { calls += 1; return db.query(...args); } };
    const result = await attachTransactionParticulars(entries, queryable);
    assert.equal(calls, 1);
    assert.equal(result, entries);
    for (const [index, source] of Object.keys(expected).entries()) {
      assert.equal(entries[index].party_name, expected[source], source);
      for (const [key, value] of Object.entries(original[index])) assert.deepEqual(entries[index][key], value, key);
    }
    assert.equal(entries[0].category, 'SALARY');
    assert.equal(entries[0].sub_category, 'SITE STAFF');
    assert.equal(entries[0].linked_client_name, 'Partner');
    assert.equal(entries[2].ledger_type, 'person');
    assert.equal(entries[11].category, 'BRICKS');
    assert.equal(entries[13].category, 'Maintenance');
    assert.deepEqual((await db.query('SELECT debit, credit FROM expenses WHERE id=1')).rows, [{ debit: '900', credit: '0' }]);

    const corrections = [{ source_key: 'expenses', source_id: 2 }, { source_key: 'plot_commission_payments', source_id: 2 }, { source_key: 'plot_commission_payments', source_id: 3 }];
    await attachTransactionParticulars(corrections, db);
    assert.equal(corrections[0].party_name, 'Refund payer');
    assert.equal(corrections[0].linked_client_name, undefined, 'a link from another site must not be exposed');
    assert.equal(corrections[1].category, 'Land purchase commission');
    assert.equal(corrections[2].category, 'Land sale commission');
  } finally { await db.close(); }
});

test('empty and unsupported source lists issue no queries', async () => {
  const db = { query() { throw new Error('unexpected query'); } };
  await attachTransactionParticulars([], db);
  const entry = { source_key: 'bank_statement_view', id: 'invalid', particular: 'RTGS' };
  await attachTransactionParticulars([entry], db);
  assert.deepEqual(entry, { source_key: 'bank_statement_view', id: 'invalid', particular: 'RTGS' });
});
