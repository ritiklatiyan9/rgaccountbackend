import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import pool from '../src/config/db.js';
import { processNotificationQueue, runComplianceScheduler } from '../src/services/complianceScheduler.service.js';

const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { resolve, promise };
};

async function fixture(t) {
  const db = new PGlite(); t.after(() => db.close());
  await db.exec(`CREATE TABLE users(id INT PRIMARY KEY,organization_id INT,is_active BOOLEAN,name TEXT,email TEXT,phone TEXT);
    INSERT INTO users VALUES(7,1,true,'Active','fixture@example.test',''),(8,1,false,'Inactive','',''),(9,2,true,'Other tenant','','');
    CREATE TABLE sites(id INT PRIMARY KEY,organization_id INT,name TEXT); INSERT INTO sites VALUES(1,1,'Fixture');
    CREATE TABLE compliance_notification_log(id INT PRIMARY KEY,organization_id INT,site_id INT,recipient_user_id INT,
      channel TEXT,message TEXT,status TEXT,attempt_count INT,created_at TIMESTAMPTZ,last_attempt_at TIMESTAMPTZ,
      sent_at TIMESTAMPTZ,delivery_reference TEXT,failure_reason TEXT);
    INSERT INTO compliance_notification_log(id,organization_id,site_id,recipient_user_id,channel,message,status,attempt_count,created_at,last_attempt_at) VALUES
      (1,1,1,7,'EMAIL','Due','PENDING',0,now(),NULL),
      (2,1,1,7,'EMAIL','Retry','FAILED',1,now(),now()-INTERVAL '20 minutes'),
      (3,1,1,8,'EMAIL','Inactive','PENDING',0,now(),NULL),
      (4,1,1,9,'EMAIL','Wrong tenant','PENDING',0,now(),NULL),
      (5,1,1,7,'EMAIL','Too soon','FAILED',1,now(),now()),
      (6,1,1,7,'EMAIL','Exhausted','FAILED',3,now(),now()-INTERVAL '20 minutes'),
      (7,1,1,7,'EMAIL','Old','PENDING',0,now()-INTERVAL '8 days',NULL);`);
  return db;
}

test('atomic claim retains retries, tenant checks and one claim round trip; delivery holds no DB query', async t => {
  const db = await fixture(t);
  let activeQueries = 0, count = 0;
  const database = { async query(sql, params) {
    activeQueries += 1; count += 1;
    try { return await db.query(sql, params); } finally { activeQueries -= 1; }
  } };
  const delivered = [];
  const result = await processNotificationQueue(database, 300, async row => {
    assert.equal(activeQueries, 0);
    assert.equal(row.organization_id, 1); assert.equal(row.active_recipient_id, 7);
    delivered.push(row.id);
    return { delivered: true, reference: 'LOCAL_TEST' };
  });
  assert.deepEqual(delivered.sort(), [1, 2]);
  assert.deepEqual(result, { delivered: 2, retried: 1 });
  assert.equal(count, 9, '4 claim statements + 4 outcome updates + empty final claim');
  const { rows } = await db.query('SELECT id,status,attempt_count FROM compliance_notification_log ORDER BY id');
  assert.deepEqual(rows.map(row => [row.id,row.status,row.attempt_count]), [
    [1,'DELIVERED',1],[2,'DELIVERED',2],[3,'SKIPPED',1],[4,'SKIPPED',1],
    [5,'FAILED',1],[6,'FAILED',3],[7,'PENDING',0],
  ]);
});

test('simultaneous local workers cannot deliver the same claimed notification', async t => {
  const db = await fixture(t);
  const sent = [];
  const deliver = async row => { sent.push(row.id); await new Promise(resolve => setImmediate(resolve)); return { delivered: true }; };
  await Promise.all([processNotificationQueue(db, 300, deliver), processNotificationQueue(db, 300, deliver)]);
  assert.deepEqual(sent.sort(), [1,2]);
});

test('scheduler suppresses overlapping ticks and returns its generation connection before claims', async t => {
  const originalConnect = pool.connect, originalQuery = pool.query;
  t.after(() => { pool.connect = originalConnect; pool.query = originalQuery; });
  const gate = deferred();
  let held = false, checkouts = 0, released = 0;
  pool.connect = async () => {
    checkouts += 1; await gate.promise; held = true;
    return { query: async () => ({ rows: [], rowCount: 0 }), release() { held = false; released += 1; } };
  };
  pool.query = async () => { assert.equal(held, false); return { rows: [] }; };
  const first = runComplianceScheduler();
  assert.deepEqual(await runComplianceScheduler(), { skipped: true });
  gate.resolve();
  assert.deepEqual(await first, { generated: 0, overdue: 0, queued: 0, delivered: 0, retried: 0 });
  assert.equal(checkouts, 1); assert.equal(released, 1);
  await runComplianceScheduler(); assert.equal(checkouts, 2);
});
