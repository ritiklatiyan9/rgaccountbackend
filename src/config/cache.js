import NodeCache from 'node-cache';

const stdTTL = parseInt(process.env.CACHE_STD_TTL_SECONDS || '45', 10);
const checkPeriod = parseInt(process.env.CACHE_CHECK_PERIOD_SECONDS || '120', 10);

export const responseCache = new NodeCache({
  stdTTL,
  checkperiod: checkPeriod,
  useClones: false,
  deleteOnExpire: true,
  maxKeys: parseInt(process.env.CACHE_MAX_KEYS || '5000', 10),
});

export const cacheEnabled = () => String(process.env.CACHE_ENABLED || 'true').toLowerCase() === 'true';

export const getCacheStats = () => responseCache.getStats();

export const clearCacheByPrefixes = (prefixes = []) => {
  if (!prefixes?.length) return 0;
  // Normalize: strip leading slashes so '/plots' matches namespace 'plots' in cache keys
  const normalized = prefixes.map((p) => p.replace(/^\/+/, ''));
  let deleted = 0;
  for (const key of responseCache.keys()) {
    if (normalized.some((prefix) => key.includes(prefix))) {
      if (responseCache.del(key) > 0) deleted += 1;
    }
  }
  return deleted;
};
