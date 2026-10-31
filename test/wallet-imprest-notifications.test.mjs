import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import pool from '../src/config/db.js';
import { enqueueWalletImprestNotification, createWalletImprestNotificationDispatcher,
  notifyWalletImprestOutbox, getWalletImprestNotificationQueueStatus,
  startWalletImprestNotificationRunner, stopWalletImprestNotificationRunner } from '../src/services/walletImprestNotifications.service.js';

async function fixture() {
  const { PGlite } = await import(process.env.PGLITE_MODULE || '@electric-sql/pglite');
  const pg = new PGlite();
  const query = async (sql, args) => args?.length ? pg.query(sql, args) : (await pg.exec(sql)).at(-1) || { rows: [] };
  let previous = Promise.resolve();
  const database = { query, connect: async () => {
    const before = previous;
    let release;
    previous = new Promise(resolve => { release = resolve; });
    await before;
    return { query, release };
  } };
  await query(`CREATE TABLE users(id integer PRIMARY KEY,organization_id integer,is_active boolean,role text);
    CREATE TABLE sites(id integer PRIMARY KEY,organization_id integer);
    CREATE TABLE user_sites(user_id integer,site_id integer);
    CREATE TABLE wallet_imprest_transfers(id uuid PRIMARY KEY,organization_id integer,site_id integer,from_user_id integer,to_user_id integer,requested_by integer);
    CREATE TABLE wallet_imprest_notification_outbox(id uuid PRIMARY KEY,transfer_id uuid REFERENCES wallet_imprest_transfers(id),event_key text UNIQUE,
      payload jsonb,created_at timestamptz DEFAULT now(),delivered_at timestamptz,attempts integer DEFAULT 0,
      next_attempt_at timestamptz DEFAULT now(),last_error text);
    INSERT INTO users VALUES(1,1,true,'sub_admin'),(2,1,true,'sub_admin'),(3,1,true,'admin'),(4,2,true,'admin');
    INSERT INTO sites VALUES(10,1);
    INSERT INTO user_sites VALUES(1,10),(2,10);`);
  const transfer = { id: randomUUID() };
  await query('INSERT INTO wallet_imprest_transfers VALUES($1,1,10,1,2,3)', [transfer.id]);
  return { database, query, transfer, close: () => pg.close() };
}

test('notification wakeups are transactional, idempotent and restricted to the two current participants', async () => {
  const f = await fixture();
  const messages = [];
  try {
    await f.query('BEGIN');
    await enqueueWalletImprestNotification(f.database, { transfer: f.transfer, event: 'requested' });
    await f.query('ROLLBACK');
    assert.equal((await f.query('SELECT count(*)::int AS count FROM wallet_imprest_notification_outbox')).rows[0].count, 0);
    const id = await enqueueWalletImprestNotification(f.database, { transfer: f.transfer, event: 'requested' });
    assert.ok(id);
    assert.equal(await enqueueWalletImprestNotification(f.database, { transfer: f.transfer, event: 'requested' }), null);
    const dispatcher = createWalletImprestNotificationDispatcher({ database: f.database, emit: (...args) => messages.push(args) });
    assert.equal(await dispatcher.drain(), 1);
    assert.deepEqual(messages, [1, 2].map(userId => [userId, 'wallet_imprest_changed', {
      transfer_id: f.transfer.id, site_id: 10, event: 'requested',
    }]));
    assert.equal(await dispatcher.drain(), 0, 'delivered rows cannot trigger duplicate wakeups');
    assert.equal(messages.length, 2, 'the requesting admin and other organization get no participant notification');
    const row = (await f.query('SELECT * FROM wallet_imprest_notification_outbox WHERE id=$1', [id])).rows[0];
    assert.ok(row.delivered_at);
    assert.equal(row.attempts, 1);
    assert.deepEqual(row.payload, { event: 'requested' }, 'outbox payload contains no account balance or name');
  } finally { await f.close(); }
});

test('delivery rechecks removed site membership, deactivation and organization before user-room emits', async () => {
  const f = await fixture();
  const messages = [];
  try {
    await enqueueWalletImprestNotification(f.database, { transfer: f.transfer, event: 'sender_accepted' });
    await f.query('DELETE FROM user_sites WHERE user_id=2');
    await f.query('UPDATE users SET is_active=false WHERE id=1');
    const dispatcher = createWalletImprestNotificationDispatcher({ database: f.database, emit: (...args) => messages.push(args) });
    assert.equal(await dispatcher.drain(), 1);
    assert.deepEqual(messages, []);
    await enqueueWalletImprestNotification(f.database, { transfer: f.transfer, event: 'accepted' });
    await f.query('UPDATE users SET is_active=true,organization_id=2 WHERE id=1');
    assert.equal(await dispatcher.drain(), 1);
    assert.deepEqual(messages, []);
  } finally { await f.close(); }
});

test('delivery failure persists bounded retry and recovery does not mutate any transfer or money', async () => {
  const f = await fixture();
  let fail = true;
  const messages = [];
  try {
    const id = await enqueueWalletImprestNotification(f.database, { transfer: f.transfer, event: 'accepted' });
    const before = (await f.query('SELECT * FROM wallet_imprest_transfers')).rows;
    const dispatcher = createWalletImprestNotificationDispatcher({ database: f.database, emit: (...args) => {
      if (fail) throw new Error('temporary socket delivery error');
      messages.push(args);
    } });
    await assert.rejects(dispatcher.drain(), /temporary socket/);
    const row = (await f.query('SELECT * FROM wallet_imprest_notification_outbox WHERE id=$1', [id])).rows[0];
    assert.equal(row.delivered_at, null);
    assert.equal(row.attempts, 1);
    assert.match(row.last_error, /temporary socket/);
    assert.ok(new Date(row.next_attempt_at) > new Date(row.created_at));
    assert.equal(await dispatcher.drain(), 0, 'backoff prevents a hot retry loop');
    fail = false;
    await f.query("UPDATE wallet_imprest_notification_outbox SET next_attempt_at=now()-interval '1 second' WHERE id=$1", [id]);
    assert.equal(await dispatcher.drain(), 1);
    assert.equal(messages.length, 2);
    assert.deepEqual((await f.query('SELECT * FROM wallet_imprest_transfers')).rows, before);
    assert.equal((await f.query('SELECT attempts FROM wallet_imprest_notification_outbox WHERE id=$1', [id])).rows[0].attempts, 2);
  } finally { await f.close(); }
});

test('bounded drain shares in-flight work and does not initialize background infrastructure on service imports', async () => {
  const f = await fixture();
  try {
    for (const event of ['requested', 'sender_accepted', 'accepted']) await enqueueWalletImprestNotification(f.database, { transfer: f.transfer, event });
    const dispatcher = createWalletImprestNotificationDispatcher({ database: f.database, emit: () => {}, batchSize: 2 });
    const first = dispatcher.drain();
    assert.equal(dispatcher.drain(), first);
    assert.equal(await first, 2);
    assert.equal(await dispatcher.drain(), 1);
    notifyWalletImprestOutbox();
    assert.equal(getWalletImprestNotificationQueueStatus().running, false);
    assert.equal(getWalletImprestNotificationQueueStatus().ready, false);
    await assert.rejects(enqueueWalletImprestNotification(f.database, { transfer: f.transfer, event: 'post-money' }), /Invalid/);
  } finally { await f.close(); }
});

test('owned BullMQ worker consumes persisted wakeups and DB fallback survives Redis outage', { timeout: 15_000 }, async t => {
  // Own the Redis process and isolated database; never use project services.
  const listener = createServer();
  listener.listen(0, '127.0.0.1');
  try { await once(listener, 'listening'); } catch (error) {
    if (['EPERM', 'EACCES'].includes(error.code)) { t.skip('loopback listeners are restricted'); return; }
    throw error;
  }
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const child = spawn(process.env.REDIS_SERVER_BIN || 'redis-server', ['--bind', '127.0.0.1', '--port', String(port), '--save', '', '--appendonly', 'no'], { stdio: ['ignore', 'pipe', 'ignore'] });
  const started = await new Promise(resolve => {
    const timeout = setTimeout(() => resolve(false), 2500);
    child.once('error', () => { clearTimeout(timeout); resolve(false); });
    child.once('exit', () => { clearTimeout(timeout); resolve(false); });
    child.stdout.on('data', chunk => { if (chunk.toString().includes('Ready to accept connections')) { clearTimeout(timeout); resolve(true); } });
  });
  if (!started) { child.kill(); t.skip('redis-server is unavailable'); return; }
  const f = await fixture();
  const originalQuery = pool.query;
  const originalConnect = pool.connect;
  const originalUrl = process.env.WALLET_IMPREST_REDIS_URL;
  const originalEnabled = process.env.WALLET_IMPREST_QUEUE_ENABLED;
  process.env.WALLET_IMPREST_REDIS_URL = `redis://127.0.0.1:${port}`;
  process.env.WALLET_IMPREST_QUEUE_ENABLED = 'true';
  pool.query = f.database.query;
  pool.connect = f.database.connect;
  try {
    startWalletImprestNotificationRunner();
    const readyBy = Date.now() + 4000;
    while (!getWalletImprestNotificationQueueStatus().ready && Date.now() < readyBy) await delay(20);
    assert.equal(getWalletImprestNotificationQueueStatus().ready, true);
    const id = await enqueueWalletImprestNotification(f.database, { transfer: f.transfer, event: 'requested' });
    notifyWalletImprestOutbox();
    const delivered = async key => Boolean((await f.query('SELECT delivered_at FROM wallet_imprest_notification_outbox WHERE id=$1', [key])).rows[0]?.delivered_at);
    const doneBy = Date.now() + 4000;
    while (!await delivered(id) && Date.now() < doneBy) await delay(20);
    assert.equal(await delivered(id), true, 'Bull worker consumes the transactional outbox job');
    child.kill('SIGTERM');
    await once(child, 'exit');
    const offlineId = await enqueueWalletImprestNotification(f.database, { transfer: f.transfer, event: 'accepted' });
    notifyWalletImprestOutbox();
    const fallbackBy = Date.now() + 4000;
    while (!await delivered(offlineId) && Date.now() < fallbackBy) await delay(20);
    assert.equal(await delivered(offlineId), true, 'outbox drains without Redis');
  } finally {
    await stopWalletImprestNotificationRunner();
    pool.query = originalQuery;
    pool.connect = originalConnect;
    if (originalUrl === undefined) delete process.env.WALLET_IMPREST_REDIS_URL;
    else process.env.WALLET_IMPREST_REDIS_URL = originalUrl;
    if (originalEnabled === undefined) delete process.env.WALLET_IMPREST_QUEUE_ENABLED;
    else process.env.WALLET_IMPREST_QUEUE_ENABLED = originalEnabled;
    child.kill('SIGTERM');
    await f.close();
  }
});
