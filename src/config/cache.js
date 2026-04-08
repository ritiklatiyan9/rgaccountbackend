import Redis from 'ioredis';

// ── Redis connection ──
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const stdTTL = parseInt(process.env.CACHE_STD_TTL_SECONDS || '45', 10);

let redis = null;
let redisReady = false;

export const initRedis = () => {
  if (redis) return redis;
  redis = new Redis(REDIS_URL, {
    maxRetriesPerRequest: 3,
    retryStrategy: (times) => Math.min(times * 200, 5000),
    lazyConnect: false,
    enableReadyCheck: true,
    connectTimeout: 10000,
  });

  redis.on('connect', () => console.log('[Redis] Connected'));
  redis.on('ready', () => { redisReady = true; console.log('[Redis] Ready'); });
  redis.on('error', (err) => { redisReady = false; console.error('[Redis] Error:', err.message); });
  redis.on('close', () => { redisReady = false; });
  redis.on('reconnecting', () => console.log('[Redis] Reconnecting...'));

  return redis;
};

export const getRedis = () => redis;
export const isRedisReady = () => redisReady;

// ── Cache helpers (compatible API with old node-cache) ──

export const cacheEnabled = () =>
  String(process.env.CACHE_ENABLED || 'true').toLowerCase() === 'true' && redisReady;

export const getDefaultTTL = () => stdTTL;

/**
 * Get a cached value by key.
 * @returns {Promise<object|null>}
 */
export const cacheGet = async (key) => {
  if (!redisReady) return null;
  try {
    const raw = await redis.get(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
};

/**
 * Set a cached value with TTL (seconds).
 */
export const cacheSet = async (key, value, ttlSeconds = stdTTL) => {
  if (!redisReady) return;
  try {
    await redis.set(key, JSON.stringify(value), 'EX', ttlSeconds);
  } catch { /* swallow — caching failure should never break requests */ }
};

/**
 * Clear all cache keys matching any of the given prefixes/namespaces.
 * Uses SCAN to avoid blocking Redis.
 */
export const clearCacheByPrefixes = async (prefixes = []) => {
  if (!redisReady || !prefixes?.length) return 0;
  const normalized = prefixes.map((p) => p.replace(/^\/+/, ''));
  let deleted = 0;
  try {
    for (const prefix of normalized) {
      let cursor = '0';
      do {
        const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', `*${prefix}*`, 'COUNT', 200);
        cursor = nextCursor;
        if (keys.length > 0) {
          await redis.del(...keys);
          deleted += keys.length;
        }
      } while (cursor !== '0');
    }
  } catch { /* swallow */ }
  return deleted;
};

/**
 * Get basic cache stats.
 */
export const getCacheStats = async () => {
  if (!redisReady) return { keys: 0, connected: false };
  try {
    const dbSize = await redis.dbsize();
    return { keys: dbSize, connected: true };
  } catch {
    return { keys: 0, connected: false };
  }
};
