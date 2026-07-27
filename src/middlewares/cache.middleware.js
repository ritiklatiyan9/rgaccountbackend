import {
  cacheEnabled,
  cacheGet,
  cacheSet,
  clearCacheByPrefixes,
  getCacheGeneration,
  getDefaultTTL,
} from '../config/cache.js';

const sortQueryEntries = (queryObj = {}) => (
  Object.entries(queryObj)
    .filter(([k]) => k !== 'nocache')
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${Array.isArray(v) ? v.join(',') : String(v)}`)
    .join('&')
);

const buildKey = (req, namespace = 'api') => {
  const userPart = req.user?.id ? `u:${req.user.id}` : 'u:anon';
  const queryPart = sortQueryEntries(req.query || {});
  return `${namespace}|${userPart}|${req.path}|${queryPart}`;
};

export const cacheResponse = ({ ttlSeconds, namespace = 'api' } = {}) => {
  const ttl = ttlSeconds ?? getDefaultTTL();
  return async (req, res, next) => {
    if (!cacheEnabled() || req.method !== 'GET') return next();

    const noCacheRequested =
      String(req.query?.nocache || '').toLowerCase() === 'true' ||
      String(req.headers['cache-control'] || '').includes('no-cache');

    if (noCacheRequested) return next();

    const key = buildKey(req, namespace);
    const requestGeneration = getCacheGeneration();

    try {
      const cached = await cacheGet(key);
      if (cached) {
        res.setHeader('X-Cache', 'HIT');
        return res.status(cached.statusCode).json(cached.payload);
      }
    } catch {
      // Redis read failure — proceed without cache
    }

    const originalJson = res.json.bind(res);
    res.json = (payload) => {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        // A mutation may have invalidated this read while its database work
        // was still running. Never let that old response refill the cache.
        if (requestGeneration === getCacheGeneration()) {
          cacheSet(key, { statusCode: res.statusCode, payload }, ttl).catch(() => {});
        }
      }
      res.setHeader('X-Cache', 'MISS');
      return originalJson(payload);
    };

    return next();
  };
};

export const invalidateCacheOnSuccess = (prefixes = []) => {
  return (_req, res, next) => {
    res.on('finish', () => {
      if (res.statusCode >= 200 && res.statusCode < 400) {
        // Every successful financial mutation can change the consolidated
        // Balance Sheet. Keeping this namespace here prevents individual
        // transaction modules from accidentally serving a stale statement.
        const effectivePrefixes = [...new Set([...prefixes, 'balance-sheet|'])];
        clearCacheByPrefixes(effectivePrefixes).catch(() => {});
      }
    });
    next();
  };
};
