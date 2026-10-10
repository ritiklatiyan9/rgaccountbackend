import { cacheEnabled, cacheGet, cacheSet, getCacheGeneration } from '../../config/cache.js';

const pendingReads = new Map();
const DASHBOARD_TTL_SECONDS = 45;

// Concurrent users and duplicate mounts share one report. Invalidation starts
// a new read and prevents an older report from repopulating the cache.
export async function readDashboardCache(key, load) {
  if (!cacheEnabled()) return load();
  const generation = getCacheGeneration();
  const cached = await cacheGet(key);
  if (generation !== getCacheGeneration()) return readDashboardCache(key, load);
  if (cached !== null) return cached;

  const pendingKey = `${generation}:${key}`;
  if (pendingReads.has(pendingKey)) return pendingReads.get(pendingKey);

  const pending = Promise.resolve().then(load).then(async result => {
    if (generation === getCacheGeneration()) {
      await cacheSet(key, result, DASHBOARD_TTL_SECONDS);
    }
    return result;
  }).finally(() => {
    pendingReads.delete(pendingKey);
  });
  pendingReads.set(pendingKey, pending);
  return pending;
}
