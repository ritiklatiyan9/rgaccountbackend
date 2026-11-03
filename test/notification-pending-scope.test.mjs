import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { chequeReadyForApproval } from '../src/utils/chequeWorkflow.js';

test('notification pending scope tracks own submissions and delegated work without exposing other staff or adding approval rights', async () => {
  const db = new PGlite();
  try {
    await db.exec(`CREATE TABLE sites(id int PRIMARY KEY,name text,organization_id int);
      CREATE TABLE user_sites(user_id int,site_id int);
      CREATE TABLE users(id int PRIMARY KEY,name text,email text);
      CREATE TABLE members(id int PRIMARY KEY,full_name text,member_type text);
      CREATE TABLE expenses(id int PRIMARY KEY,site_id int,status text,date date,assigned_admin_id int,created_by int,
        assigned_user_id int,to_entity text,from_entity text,category text,debit numeric,credit numeric,remark text,payment_mode text,voucher_url text,cheque_status text);
      INSERT INTO sites VALUES(1,'Project A',1),(2,'Other project',1),(3,'Other organisation',2);
      INSERT INTO user_sites VALUES(5,1);
      INSERT INTO users VALUES(5,'Viewer','viewer@example.test'),(6,'Other staff','staff@example.test'),(7,'Reviewer','reviewer@example.test');
      INSERT INTO expenses(id,site_id,status,date,assigned_admin_id,created_by,debit,credit) VALUES
        (1,1,'pending',CURRENT_DATE,7,5,100,0),
        (2,1,'pending',CURRENT_DATE,5,6,200,0),
        (3,1,'pending',CURRENT_DATE,7,6,300,0),
        (4,2,'pending',CURRENT_DATE,5,5,400,0),
        (5,1,'approved',CURRENT_DATE,7,5,500,0);`);
    let readable = true;
    const source = readFileSync(new URL('../src/controllers/approval.controller.js', import.meta.url), 'utf8')
      .replace(/^import[\s\S]*?;\n/gm, '').replace(/export const /g, 'const ');
    const context = { console, asyncHandler: fn => fn, chequeReadyForApproval, chequeReadySql: () => 'TRUE', hasRelation: async () => false,
      documentationPermission: async (_user, module) => readable && module === 'expense',
      attachModuleChequeDates: async () => {}, signApprovalVoucherLinks: async rows => rows,
      pool: { query: async (sql, params) => /FROM (expenses e|user_sites us)\b/.test(sql) ? db.query(sql, params) : { rows: [] } } };
    vm.createContext(context);
    vm.runInContext(`${source}\nthis.listPending = listAllPending;`, context);
    const read = async (role = 'sub_admin', site = 1, overrides = {}) => {
      let body, status = 200;
      const response = { status(value) { status = value; return this; }, json(value) { body = value; } };
      await context.listPending({ user: { id: 5, role, organization_id: 1 }, assignedApprovalsOnly: role === 'sub_admin',
        query: { site_id: String(site), module: 'expense', scope: 'notifications', ...overrides } }, response);
      return { status, body };
    };
    let result = await read();
    assert.equal(result.status, 200);
    assert.deepEqual(Array.from(result.body.entries, row => row.id), [2,1]);
    assert.equal(result.body.entries.find(row => row.id === 1).can_decide, false);
    assert.equal(result.body.entries.find(row => row.id === 2).can_decide, true);
    assert.deepEqual(Array.from((await read('sub_admin',1,{assigned_admin_id:'7'})).body.entries,row=>row.id),[2,1]);
    readable = false;
    assert.deepEqual(Array.from((await read()).body.entries,row=>row.id),[2], 'revoked module access hides own submissions while direct assignments remain visible');
    assert.equal((await read('sub_admin',2)).status,403);
    assert.equal((await read('sub_admin',3)).status,403);
    assert.equal((await read('sub_admin','')).status,400);
    for (const role of ['admin','super_admin']) {
      result = await read(role);
      assert.deepEqual(Array.from(result.body.entries,row=>row.id),[3,2,1]);
      assert.ok(result.body.entries.every(row=>row.can_decide));
    }
    await db.exec("UPDATE expenses SET status='approved' WHERE id=2");
    assert.equal((await read()).body.entries.length,0, 'resolved work leaves the pending queue');
    readable=true;
    await db.exec("INSERT INTO expenses(id,site_id,status,date,created_by,assigned_admin_id,payment_mode,cheque_status) VALUES(6,1,'pending',CURRENT_DATE,5,5,'CHEQUE','PENDING')");
    const cheque=(await read()).body.entries.find(row=>row.id===6);
    assert.ok(cheque,'owned pending cheques remain visible while awaiting clearance');
    assert.equal(cheque.can_decide,false,'tracking a cheque never bypasses clearance');
  } finally { await db.close(); }
});
