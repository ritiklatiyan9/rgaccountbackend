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
      CREATE TABLE members(id int PRIMARY KEY, full_name text, member_type text);
      CREATE TABLE firms(id int PRIMARY KEY, name text);
      INSERT INTO sites VALUES(1, 'OM ASSOCIATES'), (2, 'Other site');
      INSERT INTO users VALUES(1, 'Creator', 'creator@test.invalid'), (2, 'Reviewer', 'reviewer@test.invalid');
      CREATE TABLE expenses(id int PRIMARY KEY, site_id int, status text, date date, assigned_admin_id int,
        created_by int, assigned_user_id int, to_entity text, from_entity text, category text,
        debit numeric, credit numeric, remark text, payment_mode text, voucher_url text, bill_url text);
      INSERT INTO expenses VALUES
        (1,1,'pending',CURRENT_DATE,2,1,NULL,NULL,NULL,'OFFICE',100,0,'Supplies','CASH',NULL,NULL),
        (2,1,'pending',CURRENT_DATE,2,1,NULL,'OM ASSOCIATES','Refund payer','REFUND',0,200,'Refund','BANK',NULL,NULL),
        (3,2,'pending',CURRENT_DATE,2,1,NULL,'Other party',NULL,'OFFICE',300,0,NULL,'CASH',NULL,NULL);
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
    const context = { asyncHandler: fn => fn, console, chequeReadySql, hasRelation: async () => false,
      pool: { query: async (sql, params) => /FROM (expenses e|cash_flow_entries cfe|misc_income_entries mie)\b/.test(sql)
        ? db.query(sql, params) : { rows: [] } } };
    vm.createContext(context);
    vm.runInContext(`${controller}\nthis.list = listAllPending;`, context);
    const list = async module => {
      let body;
      await context.list({ user: { id: 2, role: 'admin' }, query: { site_id: 1, module } }, { json(value) { body = value; } });
      return body.entries;
    };
    const expenses = await list('expense');
    assert.equal(expenses.length, 2, 'site scope must remain intact');
    assert.equal(expenses.find(row => row.id === 1).entity_name, null);
    assert.equal(expenses.find(row => row.id === 1).created_by_name, 'Creator');
    assert.equal(expenses.find(row => row.id === 2).entity_name, 'Refund payer');
    const ledgers = await list('cash_flow_entry');
    assert.equal(ledgers.find(row => row.id === 1).ledger_name, 'BALAJI ASSOCIATES');
    assert.equal(ledgers.find(row => row.id === 1).ledger_type, 'person');
    assert.equal(ledgers.find(row => row.id === 2).entity_name, 'Site contractor');
    assert.equal(ledgers.find(row => row.id === 2).ledger_type, 'site');
    const income = await list('misc_income_entry');
    assert.equal(income[0].entity_name, null);
    assert.equal(income[0].category_name, 'Maintenance');
    assert.equal(income[0].credit, '500');
  } finally { await db.close(); }
});
