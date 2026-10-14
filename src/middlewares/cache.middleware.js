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
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(Array.isArray(v) ? v.join(',') : String(v))}`)
    .join('&')
);

export const buildCacheKey = (req, namespace = 'api') => {
  const userPart = req.user?.id ? `u:${req.user.id}` : 'u:anon';
  const permissions = req.user?.permissionsByModule instanceof Map
    ? [...req.user.permissionsByModule].map(([module, row]) => [module, row?.can_read === true, row?.can_view_all === true])
      .sort(([a], [b]) => a.localeCompare(b)) : [];
  const scope = encodeURIComponent(JSON.stringify([req.user?.role, req.user?.organization_id,
    req.user?.version, req.sessionId, req.authenticatedUser?.token_version, permissions]));
  const queryPart = sortQueryEntries(req.query || {});
  return `${namespace}|${userPart}|scope:${scope}|${req.path}|${queryPart}`;
};

export const cacheResponse = ({ ttlSeconds, namespace = 'api', shouldCache, authorizeHit } = {}) => {
  const ttl = ttlSeconds ?? getDefaultTTL();
  return async (req, res, next) => {
    if (!cacheEnabled() || req.method !== 'GET') return next();

    const noCacheRequested =
      String(req.query?.nocache || '').toLowerCase() === 'true' ||
      String(req.headers['cache-control'] || '').includes('no-cache');

    if (noCacheRequested) return next();

    const key = buildCacheKey(req, namespace);
    const requestGeneration = getCacheGeneration();

    let cached;
    try {
      cached = await cacheGet(key);
    } catch {
      // Redis read failure — proceed without cache
    }

    if (cached && requestGeneration === getCacheGeneration()) {
      // Some routes enforce site/record access in the controller. A cache hit
      // must recheck that boundary before returning private data.
      if (authorizeHit) {
        try {
          if (!(await authorizeHit(req, res))) return;
        } catch (error) { return next(error); }
      }
      res.setHeader('X-Cache', 'HIT');
      return res.status(cached.statusCode).json(cached.payload);
    }

    const originalJson = res.json.bind(res);
    res.json = (payload) => {
      const payloadIsCacheable = typeof shouldCache !== 'function' || shouldCache(payload, req);
      if (res.statusCode >= 200 && res.statusCode < 300 && payloadIsCacheable) {
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
        // A successful write can alter a source used by the consolidated
        // Balance Sheet, Dashboard or Management Analytics (plots and land deals also
        // change expected value without creating a ledger row). Invalidate them
        // centrally so a new module cannot accidentally leave stale KPIs.
        const effectivePrefixes = [...new Set([...prefixes, 'imprest|', 'balance-sheet|', 'site-profit|', 'dashboard:', 'management-analytics|', 'reports|'])];
        clearCacheByPrefixes(effectivePrefixes).catch(() => {});
      }
    });
    next();
  };
};
