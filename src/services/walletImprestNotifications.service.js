import { randomUUID } from 'node:crypto';
import pool from '../config/db.js';
import { emitToUser } from '../config/socket.js';

const EVENTS = new Set(['requested', 'sender_accepted', 'recipient_accepted', 'accepted', 'rejected', 'cancelled']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// This insert belongs to the same transaction as the transfer state change.
// It never sends anything before COMMIT and retries cannot duplicate an event.
export async function enqueueWalletImprestNotification(database, { transfer, event }) {
  if (!UUID.test(String(transfer?.id || '')) || !EVENTS.has(event)) throw new Error('Invalid wallet imprest notification');
  const { rows } = await database.query(`INSERT INTO wallet_imprest_notification_outbox
      (id,transfer_id,event_key,payload) VALUES ($1,$2,$3,$4::jsonb)
      ON CONFLICT(event_key) DO NOTHING RETURNING id`,
  [randomUUID(), transfer.id, `${transfer.id}:${event}`, JSON.stringify({ event })]);
  return rows[0]?.id || null;
}

// Outbox delivery is only an inbox refresh signal. Persisted, authorized
// transfer reads are the source of truth, including after an offline login.
// No cash/float posting or acceptance ever runs in this worker.
export function createWalletImprestNotificationDispatcher({ database, emit, batchSize = 20 } = {}) {
  if (!database?.connect || typeof emit !== 'function') throw new Error('Notification dispatcher requires a database and emitter');
  let draining;
  const deliverOne = async (id = null) => {
    const client = await database.connect();
    let row;
    let failure;
    const connectionError = error => { failure = error; };
    client.on?.('error', connectionError);
    try {
      await client.query('BEGIN');
      const result = await client.query(`SELECT o.id,o.transfer_id,o.payload,t.organization_id,t.site_id,
          t.from_user_id,t.to_user_id
        FROM wallet_imprest_notification_outbox o
        JOIN wallet_imprest_transfers t ON t.id=o.transfer_id
        WHERE o.delivered_at IS NULL AND o.next_attempt_at<=now()
          AND ($1::uuid IS NULL OR o.id=$1)
        ORDER BY o.next_attempt_at,o.created_at,o.id
        LIMIT 1 FOR UPDATE OF o SKIP LOCKED`, [id]);
      row = result.rows[0];
      if (!row) { await client.query('COMMIT'); return false; }
      const event = row.payload?.event;
      if (!EVENTS.has(event)) throw new Error('Unknown wallet imprest event');
      // Recheck current membership on delivery. Do not broadcast to a site or
      // to an observer/requester who cannot make either acceptance decision.
      const recipients = await client.query(`SELECT u.id FROM users u
        WHERE u.id=ANY($1::int[]) AND u.organization_id=$2 AND u.is_active=true
          AND u.role IN ('admin','super_admin','sub_admin')
          AND (u.role IN ('admin','super_admin') OR EXISTS
            (SELECT 1 FROM user_sites us WHERE us.user_id=u.id AND us.site_id=$3))
          AND EXISTS(SELECT 1 FROM sites s WHERE s.id=$3 AND s.organization_id=$2)
        ORDER BY u.id`, [[Number(row.from_user_id), Number(row.to_user_id)], row.organization_id, row.site_id]);
      const payload = { transfer_id: row.transfer_id, site_id: Number(row.site_id), event };
      for (const recipient of recipients.rows) await emit(Number(recipient.id), 'wallet_imprest_changed', payload);
      if (failure) throw failure;
      await client.query(`UPDATE wallet_imprest_notification_outbox
        SET delivered_at=now(),attempts=attempts+1,last_error=NULL WHERE id=$1`, [row.id]);
      await client.query('COMMIT');
      return true;
    } catch (error) {
      failure ||= error;
      try { await client.query('ROLLBACK'); } catch { /* failed clients are discarded below */ }
      if (row?.id) {
        // Record the retry outside the rolled-back delivery transaction. The
        // bounded backoff survives API/Redis restarts; rows are never dropped.
        // Reuse this rolled-back connection rather than requesting another
        // pool slot while still holding one (which can deadlock a small pool).
        await client.query(`UPDATE wallet_imprest_notification_outbox SET attempts=attempts+1,
          next_attempt_at=now()+LEAST(300,5*POWER(2,LEAST(attempts,6))) * interval '1 second',
          last_error=$2 WHERE id=$1 AND delivered_at IS NULL`,
        [row.id, String(error?.message || 'Notification delivery failed').slice(0, 300)]).catch(() => {});
      }
      throw error;
    } finally {
      try { client.release(failure); }
      finally { client.removeListener?.('error', connectionError); }
    }
  };
  return {
    deliverOne,
    drain() {
      if (!draining) draining = (async () => {
        let delivered = 0;
        while (delivered < batchSize && await deliverOne()) delivered += 1;
        return delivered;
      })().finally(() => { draining = null; });
      return draining;
    },
  };
}

const dispatcher = createWalletImprestNotificationDispatcher({ database: pool, emit: emitToUser });
let runtime;
let initialization;
let timer;
let pumping;
let stopped = false;
let lastWarning = 0;
const warn = error => {
  if (Date.now() - lastWarning < 60_000) return;
  lastWarning = Date.now();
  console.warn('[wallet-imprest-notifications] Retrying persisted inbox refresh:', error?.code || error?.name || 'delivery failed');
};

async function queueRuntime() {
  const url = process.env.WALLET_IMPREST_REDIS_URL || process.env.REDIS_URL;
  if (!url || process.env.WALLET_IMPREST_QUEUE_ENABLED === 'false' || stopped) return null;
  if (runtime) return runtime;
  if (!initialization) initialization = Promise.all([import('bullmq'), import('ioredis')]).then(([{ Queue, Worker }, { default: Redis }]) => {
    if (stopped) return null;
    const connection = new Redis(url, { maxRetriesPerRequest: null, enableOfflineQueue: false,
      connectTimeout: 1500, retryStrategy: attempts => Math.min(attempts * 1000, 10_000) });
    connection.on('error', warn);
    const queue = new Queue('wallet-imprest-inbox', { connection, defaultJobOptions: {
      attempts: 8, backoff: { type: 'exponential', delay: 1000 },
      // The DB row, rather than a retained Bull job ID, owns retry history.
      // Removing finished jobs allows the next due outbox retry to be queued.
      removeOnComplete: true, removeOnFail: true,
    } });
    const worker = new Worker('wallet-imprest-inbox', async job => {
      if (!UUID.test(String(job.data?.outboxId || ''))) throw new Error('Invalid outbox job');
      await dispatcher.deliverOne(job.data.outboxId);
    }, { connection, concurrency: 2 });
    queue.on('error', warn);
    worker.on('error', warn);
    worker.on('failed', (_job, error) => warn(error));
    runtime = { connection, queue, worker };
    return runtime;
  }).catch(error => { warn(error); return null; }).finally(() => { initialization = null; });
  return initialization;
}

async function pump() {
  if (stopped) return;
  if (!pumping) pumping = (async () => {
    const current = await queueRuntime();
    if (current?.connection.status === 'ready') {
      try {
        const { rows } = await pool.query(`SELECT id FROM wallet_imprest_notification_outbox
          WHERE delivered_at IS NULL AND next_attempt_at<=now()
          ORDER BY next_attempt_at,created_at LIMIT 20`);
        await Promise.all(rows.map(row => current.queue.add('refresh-inbox', { outboxId: row.id }, { jobId: row.id })));
        return;
      } catch (error) { warn(error); }
    }
    // Optional Redis must never be a prerequisite for requesting/accepting
    // money. The same durable rows are drained in small batches when offline.
    await dispatcher.drain();
  })().catch(warn).finally(() => { pumping = null; });
  return pumping;
}

export const notifyWalletImprestOutbox = () => { if (timer && !stopped) void pump(); };

export function startWalletImprestNotificationRunner() {
  stopped = false;
  if (timer) return;
  timer = setInterval(() => { void pump(); }, 2000);
  timer.unref?.();
  void pump();
}

export async function stopWalletImprestNotificationRunner() {
  stopped = true;
  clearInterval(timer);
  timer = null;
  const current = runtime || await initialization;
  await pumping;
  runtime = null;
  if (current) {
    await Promise.allSettled([current.worker.close(true), current.queue.close()]);
    current.connection.disconnect();
  }
}

export const getWalletImprestNotificationQueueStatus = () => ({
  configured: Boolean(process.env.WALLET_IMPREST_REDIS_URL || process.env.REDIS_URL),
  ready: runtime?.connection.status === 'ready', running: Boolean(timer),
});
