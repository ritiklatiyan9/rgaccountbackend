import assert from 'node:assert/strict';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { loadImprestApprovalActivity } from '../src/services/imprestApprovalActivity.service.js';
import { up as addIndexes } from '../src/migrations/197_imprest_approval_activity_indexes.js';

test('Imprest approval activity isolates sites and permissions and reflects decisions', async (t) => {
  const db = new PGlite();
  try {
    await db.exec(`
      CREATE TABLE users(id integer PRIMARY KEY, name text);
      INSERT INTO users VALUES (1,'Admin'),(2,'Alice'),(3,'Bob'),(4,'Observer');
      CREATE TABLE sites(id integer PRIMARY KEY, name text);
      INSERT INTO sites VALUES (10,'First site'),(20,'Other site');
      CREATE TABLE imprest_expense_requests(id integer PRIMARY KEY, site_id integer, sub_admin_id integer,
        assigned_admin_id integer, amount numeric, status text, request_type text, created_at timestamptz DEFAULT now());
      INSERT INTO imprest_expense_requests(id,site_id,sub_admin_id,assigned_admin_id,amount,status,request_type) VALUES
        (1,10,2,1,100,'PENDING','IMPREST'),(2,10,3,2,200,'PENDING','EXPENSE'),
        (3,10,2,2,50,'PENDING','IMPREST'),(4,20,3,2,999,'PENDING','IMPREST'),
        (5,10,2,1,75,'APPROVED','IMPREST');
      CREATE TABLE imprest_allocations(id integer PRIMARY KEY, site_id integer, admin_id integer, sub_admin_id integer,
        assigned_admin_id integer, amount numeric, status text, created_at timestamptz DEFAULT now());
      INSERT INTO imprest_allocations(id,site_id,admin_id,sub_admin_id,amount,status) VALUES
        (1,10,1,2,300,'PENDING_RECEIPT'),(2,10,2,3,20,'PENDING_RECEIPT'),
        (3,20,1,2,999,'PENDING_RECEIPT'),(4,10,1,3,25,'RECEIVED');
      CREATE TABLE imprest_returns(id integer PRIMARY KEY, site_id integer, sub_admin_id integer, assigned_admin_id integer,
        amount numeric, status text, created_at timestamptz DEFAULT now());
      INSERT INTO imprest_returns(id,site_id,sub_admin_id,assigned_admin_id,amount,status) VALUES
        (1,10,2,1,40,'PENDING'),(2,20,2,1,999,'PENDING');
    `);
    const migrationDb = { query: (sql,args) => db.query(sql,args), release() {} };
    const migrationPool = { connect: async () => migrationDb };
    await addIndexes(migrationPool);
    await addIndexes(migrationPool);
    assert.equal((await db.query("SELECT count(*)::integer AS n FROM pg_indexes WHERE indexname LIKE 'idx_imprest_%'")).rows[0].n,6);
    const snapshot = (overrides = {}) => loadImprestApprovalActivity(db, {
      siteId: 10, userId: 2, isAdmin: false, canReadPersonal: true, canManage: false, ...overrides,
    });
    await t.test('personal inbox contains only assigned reviews and the callers pending receipts', async () => {
      const activity = await snapshot();
      assert.deepEqual(activity.received.map(r => [r._type,r.id]).sort(), [['allocation',1],['imprest',2]]);
      assert.equal(activity.counts.received, 2);
      assert.equal(activity.counts.sent_pending, 4);
      assert.deepEqual(activity.totals, {debit:200,credit:300});
      assert.ok(activity.received.every(r => r.can_decide));
      assert.ok(activity.sent.every(r => !r.can_decide && r.site_id === 10));
      assert.ok(activity.sent.some(r => r.id === 5 && r.status === 'APPROVED'));
    });
    await t.test('administrators receive every site request and return plus their own sent handovers', async () => {
      const activity = await snapshot({userId:1,isAdmin:true,canManage:true});
      assert.equal(activity.counts.received,4);
      assert.deepEqual(activity.totals,{debit:350,credit:40});
      assert.ok(activity.received.every(r => r.can_decide && r.site_id === 10));
      assert.deepEqual(activity.sent.map(r => r.id).sort(),[1,4]);
      assert.equal(activity.counts.sent_pending,1);
    });
    await t.test('Management grants site visibility without granting financial decisions', async () => {
      const activity = await snapshot({userId:4,canReadPersonal:false,canManage:true});
      assert.equal(activity.counts.received,4);
      assert.ok(activity.received.every(r => r.can_decide === false));
      assert.deepEqual(activity.sent,[]);
      const assignedObserver = await snapshot({canManage:true});
      assert.ok(assignedObserver.received.find(r => r._type==='imprest' && r.id===2).can_decide);
      assert.equal(assignedObserver.received.find(r => r._type==='imprest' && r.id===3).can_decide,false);
      assert.equal(assignedObserver.received.find(r => r._type==='imprest_return').can_decide,false);
    });
    await t.test('revocation removes both the inbox and history immediately', async () => {
      const activity = await snapshot({canReadPersonal:false,canManage:false});
      assert.deepEqual(activity.received,[]); assert.deepEqual(activity.sent,[]);
      assert.deepEqual(activity.counts,{received:0,sent_pending:0});
      assert.deepEqual(activity.totals,{debit:0,credit:0});
    });
    await t.test('confirmation and rejection disappear from inbox and update senders history', async () => {
      await db.query("UPDATE imprest_allocations SET status='RECEIVED' WHERE id=1");
      await db.query("UPDATE imprest_expense_requests SET status='REJECTED' WHERE id=2");
      const recipient = await snapshot();
      assert.equal(recipient.counts.received,0);
      assert.deepEqual(recipient.totals,{debit:0,credit:0});
      const sender = await snapshot({userId:1,isAdmin:true,canManage:true});
      assert.equal(sender.sent.find(r=>r.id===1).status,'RECEIVED');
      assert.equal(sender.counts.sent_pending,0);
    });
    await t.test('history is bounded without truncating outstanding counts', async () => {
      await db.exec(`INSERT INTO imprest_allocations(id,site_id,admin_id,sub_admin_id,amount,status)
        SELECT i,10,1,3,1,'PENDING_RECEIPT' FROM generate_series(100,249) i;`);
      const sender = await snapshot({userId:1,isAdmin:true,canManage:true});
      assert.equal(sender.sent.length,100);
      assert.equal(sender.counts.sent_pending,150);
    });
  } finally { await db.close(); }
});
