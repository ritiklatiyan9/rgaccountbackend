import { createHash } from 'node:crypto';
import { cacheEnabled, cacheGet, cacheSet, cacheDelete, getCacheGeneration, onCacheInvalidation } from '../config/cache.js';

export const PROFIT_SNAPSHOT_FRESH_MS = 45_000;
export const PROFIT_SNAPSHOT_STALE_MS = 5 * 60_000;
const NAMESPACE = 'site-profit|portfolio:';
const REVISION_KEY = 'profit-portfolio:revision';
const pending = new Map();
const localSnapshotKeys = new Set();
const MAX_LOCAL_SNAPSHOTS = 32;
let runtime = null;
let runtimeStarted = false;
let runtimeInitialization = null;
let sharedInvalidations = 0;
let flushingInvalidations = null;

export const profitSnapshotKey = ({ userId, siteIds, end, excludeOldPlots }) => createHash('sha256')
  .update(JSON.stringify([String(userId), [...new Set(siteIds.map(Number))].sort((a, b) => a - b), end, Boolean(excludeOldPlots)]))
  .digest('hex');

// Redis is optional: a missing or unavailable queue never delays the cold path.
// BullMQ refreshes old snapshots in the background; cold reads always use SQL.
function queueRuntime() {
  const url = process.env.PROFIT_PORTFOLIO_REDIS_URL || process.env.REDIS_URL;
  if (!url || process.env.PROFIT_PORTFOLIO_QUEUE_ENABLED === 'false') return null;
  if (!runtimeStarted) {
    runtimeStarted = true;
    // Fence snapshots left by an earlier process, including an outage/restart.
    sharedInvalidations += 1;
    runtimeInitialization = Promise.all([import('bullmq'), import('ioredis')]).then(([{ Queue, Worker }, { default: Redis }]) => {
      const connection = new Redis(url, { maxRetriesPerRequest: 1, enableOfflineQueue: false,
        connectTimeout: 1000, commandTimeout: 500, retryStrategy: times => Math.min(times * 1000, 15_000) });
      const workerConnection = new Redis(url, { maxRetriesPerRequest: null,
        connectTimeout: 1000, retryStrategy: times => Math.min(times * 1000, 15_000) });
      const queue = new Queue('profit-portfolio-refresh', { connection, defaultJobOptions: {
        attempts: 2, backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: true, removeOnFail: { age: 3600, count: 100 },
      } });
      const worker = new Worker('profit-portfolio-refresh', async job => {
        const { buildProfitPortfolio } = await import('./profitPortfolio.service.js');
        const { params, revision } = job.data;
        await flushSharedInvalidations(runtime);
        if (String(await connection.get(REVISION_KEY) || '0') !== revision) return;
        await rebuild(params, () => buildProfitPortfolio(params.siteIds, params.end, params.excludeOldPlots),
          { generation: getCacheGeneration(), revision, shared: runtime });
      }, { connection: workerConnection, concurrency: 1 });
      // Connection failures fall back to local single-flight rebuilding. A worker
      // continues reconnecting so a temporary Redis outage needs no API restart.
      const logError = error => {
        if (process.env.NODE_ENV !== 'test') console.warn('[profit-portfolio queue]', error.message);
      };
      connection.on('error', logError);
      workerConnection.on('error', logError);
      queue.on('error', logError);
      worker.on('error', logError);
      worker.on('failed', (_job, error) => logError(error));
      runtime = { connection, workerConnection, queue, worker };
    }).catch(error => {
      if (process.env.NODE_ENV !== 'test') console.warn('[profit-portfolio queue unavailable]', error.message);
    });
  }
  return runtime?.connection.status === 'ready' ? runtime : null;
}

async function flushSharedInvalidations(shared) {
  if (!shared) return;
  // Every caller waits for mutations that arrive during an in-flight INCR too.
  while (sharedInvalidations) {
    if (!flushingInvalidations) {
      const count = sharedInvalidations;
      flushingInvalidations = shared.connection.incrby(REVISION_KEY, count).then(() => {
        sharedInvalidations -= count;
      }).finally(() => { flushingInvalidations = null; });
    }
    await flushingInvalidations;
  }
}

onCacheInvalidation(async prefixes => {
  if (!prefixes.some(prefix => /site-profit|sites|dashboard|cashflow/.test(prefix))) return;
  sharedInvalidations += 1;
  const shared = queueRuntime();
  if (shared) {
    try { await flushSharedInvalidations(shared); } catch { /* flush before trusting Redis again */ }
  }
});

async function snapshotContext() {
  const shared = queueRuntime();
  let revision = 'local';
  if (shared) {
    try {
      await flushSharedInvalidations(shared);
      revision = String(await shared.connection.get(REVISION_KEY) || '0');
    }
    catch { return { generation: getCacheGeneration(), revision, shared: null }; }
  }
  return { generation: getCacheGeneration(), revision, shared };
}

async function saveLocalSnapshot(key, snapshot) {
  const fullKey = `${NAMESPACE}${key}`;
  localSnapshotKeys.delete(fullKey);
  localSnapshotKeys.add(fullKey);
  while (localSnapshotKeys.size > MAX_LOCAL_SNAPSHOTS) {
    const oldest = localSnapshotKeys.values().next().value;
    localSnapshotKeys.delete(oldest);
    await cacheDelete(oldest);
  }
  await cacheSet(fullKey, snapshot, PROFIT_SNAPSHOT_STALE_MS / 1000);
}

async function readSnapshot(key, context) {
  let cached = await cacheGet(`${NAMESPACE}${key}`);
  if (cached?.generation !== context.generation || cached?.revision !== context.revision) cached = null;
  if (!cached && context.shared) {
    try {
      const raw = await context.shared.connection.get(`profit-portfolio:snapshot:${context.revision}:${key}`);
      if (raw) {
        cached = { ...JSON.parse(raw), generation: context.generation, revision: context.revision };
        await saveLocalSnapshot(key, cached);
      }
    } catch { /* cached SQL remains available without Redis */ }
  }
  return cached;
}

async function rebuild(params, build, context) {
  const key = profitSnapshotKey(params);
  const pendingKey = `${context.generation}:${context.revision}:${key}`;
  if (pending.has(pendingKey)) return pending.get(pendingKey);
  const work = Promise.resolve().then(build).then(async value => {
    const snapshot = { value, generatedAt: new Date().toISOString(), generation: context.generation, revision: context.revision };
    // Do not let a pre-mutation read refill a cache or bless a partial report.
    if (!value.failures?.length && !value.data?.some(site => site.personalLedgersUnavailable || site.profitPaymentsUnavailable)
      && context.generation === getCacheGeneration()) {
      if (context.shared) {
        try {
          const current = String(await context.shared.connection.get(REVISION_KEY) || '0');
          if (current !== context.revision) return snapshot;
          await context.shared.connection.set(`profit-portfolio:snapshot:${context.revision}:${key}`,
            JSON.stringify(snapshot), 'EX', PROFIT_SNAPSHOT_STALE_MS / 1000);
        } catch { /* store locally even if the queue is temporarily unavailable */ }
      }
      if (context.generation === getCacheGeneration()) await saveLocalSnapshot(key, snapshot);
    }
    return snapshot;
  }).finally(() => pending.delete(pendingKey));
  pending.set(pendingKey, work);
  return work;
}

const reply = (snapshot, refreshing, cacheStatus) => ({
  value: snapshot.value, generatedAt: snapshot.generatedAt, refreshing, cacheStatus,
});

export async function getProfitPortfolioSnapshot(params, build) {
  if (!cacheEnabled()) return reply({ value: await build(), generatedAt: new Date().toISOString() }, false, 'disabled');
  const context = await snapshotContext();
  const key = profitSnapshotKey(params);
  const cached = await readSnapshot(key, context);
  if (context.generation !== getCacheGeneration()) return getProfitPortfolioSnapshot(params, build);
  const age = cached ? Date.now() - Date.parse(cached.generatedAt) : Infinity;
  if (!params.refresh && age < PROFIT_SNAPSHOT_FRESH_MS) return reply(cached, false, 'fresh');
  if (!params.refresh && age < PROFIT_SNAPSHOT_STALE_MS) {
    const fallback = () => rebuild(params, build, context).catch(error => {
      if (process.env.NODE_ENV !== 'test') console.warn('[profit-portfolio refresh]', error.message);
    });
    if (context.shared) {
      // A deterministic ID makes concurrent stale reads share the same queue job.
      context.shared.queue.add('refresh', { params: { ...params, refresh: false }, revision: context.revision },
        { jobId: `snapshot-${context.revision}-${key}` }).catch(fallback);
    } else fallback();
    return reply(cached, true, 'stale');
  }
  return reply(await rebuild(params, build, context), false, 'rebuilt');
}

export const getProfitPortfolioQueueStatus = () => ({ started: runtimeStarted, ready: runtime?.connection.status === 'ready' });

export async function closeProfitPortfolioQueue() {
  if (runtimeInitialization) await runtimeInitialization;
  if (!runtime) return;
  const active = runtime;
  runtime = null;
  await Promise.allSettled([active.worker.close(), active.queue.close()]);
  active.connection.disconnect();
  active.workerConnection.disconnect();
}
