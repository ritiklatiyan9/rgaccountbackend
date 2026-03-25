import { cacheEnabled, clearCacheByPrefixes, responseCache } from '../config/cache.js';

const sortQueryEntries = (queryObj = {}) => (
  Object.entries(queryObj)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${Array.isArray(v) ? v.join(',') : String(v)}`)
    .join('&')
);

const buildKey = (req, namespace = 'api') => {
  const userPart = req.user?.id ? `u:${req.user.id}` : 'u:anon';
  const queryPart = sortQueryEntries(req.query || {});
  return `${namespace}|${userPart}|${req.path}|${queryPart}`;
};

export const cacheResponse = ({ ttlSeconds = 45, namespace = 'api' } = {}) => {
  return (req, res, next) => {
    if (!cacheEnabled() || req.method !== 'GET') return next();

    const noCacheRequested =
      String(req.query?.nocache || '').toLowerCase() === 'true' ||
      String(req.headers['cache-control'] || '').includes('no-cache');

    if (noCacheRequested) return next();

    const key = buildKey(req, namespace);
    const cached = responseCache.get(key);
    if (cached) {
      res.setHeader('X-Cache', 'HIT');
      return res.status(cached.statusCode).json(cached.payload);
    }

    const originalJson = res.json.bind(res);
    res.json = (payload) => {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        responseCache.set(
          key,
          { statusCode: res.statusCode, payload },
          ttlSeconds,
        );
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
        clearCacheByPrefixes(prefixes);
      }
    });
    next();
  };
};
