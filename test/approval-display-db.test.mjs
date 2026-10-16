import { attachModuleChequeDates } from '../src/services/chequeDates.service.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { PGlite } from '@electric-sql/pglite';
import { chequeReadySql } from '../src/utils/chequeWorkflow.js';

test('approval queries preserve recorded parties, ledger ownership and categories without substituting creators', async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      CREATE TABLE sites(id int PRIMARY KEY, name text);
      CREATE TABLE users(id int PRIMARY KEY, name text, email text);
      CREATE TABLE members(id int PRIMARY KEY, full_name text, member_type text,site_id int,phone text);
      INSERT INTO members VALUES(1,'Linked expense client','Client',1,'111'),(2,'Other linked client','Client',1,'222'),(3,'Other site client','Client',2,'333');
      CREATE TABLE transaction_party_links(source_key text,source_id int,site_id int,member_id int);
      INSERT INTO transaction_party_links VALUES('expense',1,1,1),('expense',2,1,2),('cashflow_entry',1,1,2),('misc_income_entry',1,1,1),('expense',4,2,3);
      CREATE TABLE firms(id int PRIMARY KEY, name text);
      INSERT INTO sites VALUES(1, 'OM ASSOCIATES'), (2, 'Other site');
      INSERT INTO users VALUES(1, 'Creator', 'creator@test.invalid'), (2, 'Reviewer', 'reviewer@test.invalid');
      CREATE TABLE expenses(id int PRIMARY KEY, site_id int, status text, date date, assigned_admin_id int,
        created_by int, assigned_user_id int, to_entity text, from_entity text, category text,
        debit numeric, credit numeric, remark text, payment_mode text, voucher_url text, bill_url text);
      INSERT INTO expenses VALUES
        (1,1,'pending',CURRENT_DATE,2,1,NULL,NULL,NULL,'OFFICE',100,0,'Supplies','CASH',NULL,NULL),
        (2,1,'pending',CURRENT_DATE,2,1,NULL,'OM ASSOCIATES','Refund payer','REFUND',0,200,'Refund','BANK',NULL,NULL),
        (3,2,'pending',CURRENT_DATE,2,1,NULL,'Other party',NULL,'OFFICE',300,0,NULL,'CASH',NULL,NULL),
        (4,1,'pending',CURRENT_DATE,2,1,NULL,NULL,NULL,'OFFICE',100,0,NULL,'CASH',NULL,NULL);
      CREATE TABLE cash_flow_months(id int PRIMARY KEY, ledger_name text, ledger_type text, month int, year int, linked_user_id int);
      INSERT INTO cash_flow_months VALUES(1,'BALAJI ASSOCIATES','person',10,2026,1), (2,'Main site','site',10,2026,NULL);
      CREATE TABLE cash_flow_entries(id int PRIMARY KEY, site_id int, status text, date date,
        created_by int, assigned_admin_id int, cash_flow_month_id int, from_firm_id int, to_firm_id int,
        to_name text, particular text, source_module text, debit numeric, credit numeric);
      INSERT INTO cash_flow_entries VALUES
        (1,1,'pending',CURRENT_DATE,1,2,1,NULL,NULL,NULL,'RTGS',NULL,300,0),
        (2,1,'pending',CURRENT_DATE,1,2,2,NULL,NULL,'Site contractor','Boundary work',NULL,400,0);
      CREATE TABLE misc_income_categories(id int PRIMARY KEY, name text, color text);
      INSERT INTO misc_income_categories VALUES(1,'Maintenance','blue');
      CREATE TABLE misc_income_entries(id int PRIMARY KEY, site_id int, status text, date date,
        created_by int, assigned_admin_id int, category_id int, party_name text, direction text, amount numeric);
      INSERT INTO misc_income_entries VALUES(1,1,'pending',CURRENT_DATE,1,2,1,NULL,'credit',500);
    `);
    const controller = readFileSync(new URL('../src/controllers/approval.controller.js', import.meta.url), 'utf8')
      .replace(/^import[\s\S]*?;\n/gm, '').replace(/export const /g, 'const ');
    const context = { attachModuleChequeDates, asyncHandler: fn => fn, console, chequeReadySql, hasRelation: async name => name==='transaction_party_links',
      pool: { query: async (sql, params) => /FROM (expenses e|cash_flow_entries cfe|misc_income_entries mie|transaction_party_links l)\b/.test(sql)
        ? db.query(sql, params) : { rows: [] } } };
    vm.createContext(context);
    vm.runInContext(`${controller}\nthis.list = listAllPending; this.enrich=attachApprovalClientLinks;`, context);
    const list = async module => {
      let body;
      await context.list({ user: { id: 2, role: 'admin' }, query: { site_id: 1, module } }, { json(value) { body = value; } });
      return body.entries;
    };
    const expenses = await list('expense');
    assert.equal(expenses.length, 3, 'site scope must remain intact');
    assert.equal(expenses.find(row => row.id === 1).entity_name, null);
    assert.equal(expenses.find(row => row.id === 1).created_by_name, 'Creator');
    assert.equal(expenses.find(row => row.id === 1).linked_client_name, 'Linked expense client');
    assert.equal(expenses.find(row => row.id === 1).linked_client_id, 1);
    assert.equal(expenses.find(row => row.id === 1).debit, '100');
    assert.equal(expenses.find(row => row.id === 2).entity_name, 'Refund payer');
    assert.equal(expenses.find(row => row.id === 2).linked_client_name, 'Other linked client');
    assert.equal(expenses.find(row => row.id === 4).linked_client_name, undefined, 'a link from another site must not populate this notification');
    const ledgers = await list('cash_flow_entry');
    assert.equal(ledgers.find(row => row.id === 1).ledger_name, 'BALAJI ASSOCIATES');
    assert.equal(ledgers.find(row => row.id === 1).ledger_type, 'person');
    assert.equal(ledgers.find(row => row.id === 1).linked_client_name, 'Other linked client', 'identical record IDs in different modules must keep their own links');
    assert.equal(ledgers.find(row => row.id === 2).entity_name, 'Site contractor');
    assert.equal(ledgers.find(row => row.id === 2).ledger_type, 'site');
    const income = await list('misc_income_entry');
    assert.equal(income[0].entity_name, null);
    assert.equal(income[0].category_name, 'Maintenance');
    assert.equal(income[0].credit, '500');
    assert.equal(income[0].linked_client_name, 'Linked expense client');
    const mirror={source:'daybook_expense',id:99,expense_id:1,site_id:1,debit:'100'};
    await context.enrich([mirror]);
    assert.equal(mirror.linked_client_name,'Linked expense client');assert.equal(mirror.id,99);assert.equal(mirror.debit,'100');
    await db.exec("DELETE FROM transaction_party_links WHERE source_key='expense' AND source_id=1");
    assert.equal((await list('expense')).find(row=>row.id===1).linked_client_name,undefined,'unlinking must clear the name on the next read');
    await db.exec('DROP TABLE transaction_party_links');context.hasRelation=async()=>false;
    assert.equal((await list('expense')).length,3,'older schemas must keep the approval queue available');
  } finally { await db.close(); }
});
