import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { neutralizeRestoredJobs } from '../src/services/backupOperationalState.js';

const sourceTables = names => names.map(name => ({ name, columns: [], rows: [] }));
const schemaFor = definitions => ({ tables: Object.entries(definitions).map(([name, columns]) => ({ name, columns: columns.map(name => ({ name })) })) });

test('merging without inserted identities never changes queues, login challenges or calendar connections', async () => {
  const client = { query: () => assert.fail('Merge must not mutate operational state') };
  const result = await neutralizeRestoredJobs(client, schemaFor({ event_reminders: ['status'] }), sourceTables(['event_reminders']), { mode: 'merge' });
  assert.deepEqual(result, { cancelledJobs: 0, calendarReconnectRequired: false, invalidatedLoginChallenges: 0 });
});

test('merge cancellation is bound to inserted IDs instead of all archive IDs', async () => {
  const calls = [];
  const client = { query: async (sql, parameters) => { calls.push({ sql, parameters }); return { rowCount: 1 }; } };
  const schema = schemaFor({ event_reminders: ['id', 'status', 'failure_reason'] });
  const result = await neutralizeRestoredJobs(client, schema, sourceTables(['event_reminders']), { mode: 'merge', insertedIds: { event_reminders: ['9'] } });
  assert.equal(result.cancelledJobs, 1);
  assert.match(calls[0].sql, /id::text=ANY\(\$4::text\[\]\)/);
  assert.deepEqual(calls[0].parameters[3], ['9']);
});

test('only included, recognized installed tables are updated; optional columns are handled', async () => {
  const calls = [];
  const client = { query: async (sql, parameters) => { calls.push({ sql, parameters }); return { rowCount: 2 }; } };
  const schema = schemaFor({ event_reminders: ['status'], sms_reminder_log: ['status', 'error'], unrelated: ['status'] });
  const result = await neutralizeRestoredJobs(client, schema, sourceTables(['event_reminders', 'unrelated']), { mode: 'replace' });
  assert.equal(result.cancelledJobs, 2); assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /public\.event_reminders/);
  assert.deepEqual(calls[0].parameters, ['CANCELLED', ['PENDING', 'PROCESSING', 'FAILED']]);
});

test('OTP schemas without consumed_at can expire restored challenges', async () => {
  const calls = [];
  const client = { query: async sql => { calls.push(sql); return { rowCount: 3 }; } };
  const result = await neutralizeRestoredJobs(client, schemaFor({ login_otps: ['expires_at'] }), sourceTables(['login_otps']), { mode: 'replace' });
  assert.equal(result.invalidatedLoginChallenges, 3);
  assert.match(calls[0], /expires_at=CURRENT_TIMESTAMP-INTERVAL '1 second'/);
  await assert.rejects(neutralizeRestoredJobs(client, { tables: [] }, [], { mode: 'unknown' }), /mode/);
});

const modulePath = process.env.BACKUP_DB_TEST_MODULE;
const { PGlite } = await import(modulePath
  ? (modulePath.startsWith('file:') ? modulePath : pathToFileURL(modulePath).href)
  : '@electric-sql/pglite');

test('actual PostgreSQL cancellation retains sent history and financial approvals and rolls back with restore', async t => {
  const db = new PGlite(); t.after(() => db.close());
  await db.exec(`
    CREATE TABLE event_reminders(id serial primary key,status text CHECK(status IN('PENDING','PROCESSING','FAILED','CANCELLED','SENT','SKIPPED')),failure_reason text,updated_at timestamptz);
    CREATE TABLE compliance_notification_log(id serial primary key,status text,failure_reason text);
    CREATE TABLE client_message_campaigns(id serial primary key,status text CHECK(status IN('QUEUING','QUEUED','SENDING','COMPLETED','PARTIAL','FAILED')),sent_count int default 0,failed_count int default 0,skipped_count int default 0,updated_at timestamptz);
    CREATE TABLE client_message_deliveries(id serial primary key,campaign_id int references client_message_campaigns(id),status text CHECK(status IN('QUEUED','SENDING','SENT','FAILED','SKIPPED')),error text,updated_at timestamptz);
    CREATE TABLE sms_reminder_log(id serial primary key,status text,error text);
    CREATE TABLE google_calendar_connections(id serial primary key,status text,updated_at timestamptz);
    CREATE TABLE login_otps(id serial primary key,consumed_at timestamptz,expires_at timestamptz);
    CREATE TABLE expenses(id serial primary key,status text);
    INSERT INTO event_reminders(status) VALUES('PENDING'),('PROCESSING'),('FAILED'),('SENT');
    INSERT INTO compliance_notification_log(status) VALUES('PENDING'),('DELIVERED');
    INSERT INTO client_message_campaigns(status) VALUES('QUEUED');
    INSERT INTO client_message_deliveries(campaign_id,status) VALUES(1,'QUEUED'),(1,'SENDING'),(1,'SENT');
    INSERT INTO sms_reminder_log(status) VALUES('queued'),('sent');
    INSERT INTO google_calendar_connections(status) VALUES('active'),('disconnected');
    INSERT INTO login_otps(consumed_at,expires_at) VALUES(NULL,NOW()+INTERVAL '5 minutes'),(NOW()-INTERVAL '1 hour',NOW()-INTERVAL '1 hour');
    INSERT INTO expenses(status) VALUES('PENDING'),('APPROVED');
  `);
  const { rows: definitions } = await db.query("SELECT table_name,column_name FROM information_schema.columns WHERE table_schema='public' ORDER BY table_name,ordinal_position");
  const grouped = {};
  for (const row of definitions) (grouped[row.table_name] ||= []).push(row.column_name);
  const schema = schemaFor(grouped); const tables = sourceTables(Object.keys(grouped));
  const client = { query: async (sql, values) => { const result = await db.query(sql, values); return { ...result, rowCount: result.affectedRows }; } };
  await db.exec('BEGIN');
  const result = await neutralizeRestoredJobs(client, schema, tables, { mode: 'replace' });
  assert.deepEqual(result, { cancelledJobs: 7, calendarReconnectRequired: true, invalidatedLoginChallenges: 1 });
  assert.deepEqual((await db.query('SELECT status FROM event_reminders ORDER BY id')).rows.map(r => r.status), ['CANCELLED', 'CANCELLED', 'CANCELLED', 'SENT']);
  assert.deepEqual((await db.query('SELECT status FROM compliance_notification_log ORDER BY id')).rows.map(r => r.status), ['SKIPPED', 'DELIVERED']);
  assert.deepEqual((await db.query('SELECT status,sent_count,failed_count,skipped_count FROM client_message_campaigns')).rows, [{ status: 'COMPLETED', sent_count: 1, failed_count: 0, skipped_count: 2 }]);
  assert.deepEqual((await db.query('SELECT status FROM sms_reminder_log ORDER BY id')).rows.map(r => r.status), ['cancelled', 'sent']);
  assert.deepEqual((await db.query('SELECT status FROM google_calendar_connections ORDER BY id')).rows.map(r => r.status), ['reauthorization_required', 'disconnected']);
  assert.equal((await db.query('SELECT count(*)::int AS total FROM login_otps WHERE consumed_at IS NULL')).rows[0].total, 0);
  assert.deepEqual((await db.query('SELECT status FROM expenses ORDER BY id')).rows.map(r => r.status), ['PENDING', 'APPROVED']);
  const second = await neutralizeRestoredJobs(client, schema, tables, { mode: 'replace' });
  assert.deepEqual(second, { cancelledJobs: 0, calendarReconnectRequired: false, invalidatedLoginChallenges: 0 });
  await db.exec('ROLLBACK');
  assert.equal((await db.query("SELECT status FROM event_reminders WHERE id=1")).rows[0].status, 'PENDING');
  assert.equal((await db.query("SELECT status FROM google_calendar_connections WHERE id=1")).rows[0].status, 'active');
  await db.exec(`
    INSERT INTO event_reminders(status) VALUES('PENDING');
    INSERT INTO client_message_campaigns(status) VALUES('QUEUED');
    INSERT INTO client_message_deliveries(campaign_id,status) VALUES(2,'QUEUED');
    INSERT INTO sms_reminder_log(status) VALUES('queued');
    INSERT INTO google_calendar_connections(status) VALUES('active');
    INSERT INTO login_otps(expires_at) VALUES(NOW()+INTERVAL '5 minutes');
  `);
  const merge = await neutralizeRestoredJobs(client, schema, tables, { mode: 'merge', insertedIds: new Map([
    ['event_reminders', ['5']], ['client_message_campaigns', ['2']], ['client_message_deliveries', ['4']],
    ['sms_reminder_log', ['3']], ['google_calendar_connections', ['3']], ['login_otps', ['3']],
  ]) });
  assert.deepEqual(merge, { cancelledJobs: 3, calendarReconnectRequired: true, invalidatedLoginChallenges: 1 });
  assert.deepEqual((await db.query('SELECT status FROM event_reminders WHERE id IN (1,5) ORDER BY id')).rows.map(r => r.status), ['PENDING', 'CANCELLED']);
  assert.deepEqual((await db.query('SELECT status FROM client_message_campaigns ORDER BY id')).rows.map(r => r.status), ['QUEUED', 'COMPLETED']);
  assert.deepEqual((await db.query('SELECT status FROM google_calendar_connections WHERE id IN (1,3) ORDER BY id')).rows.map(r => r.status), ['active', 'reauthorization_required']);
  assert.equal((await db.query('SELECT count(*)::int AS total FROM login_otps WHERE consumed_at IS NULL')).rows[0].total, 1);
});
