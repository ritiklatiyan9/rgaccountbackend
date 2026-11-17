import express from 'express';

import {
  getDashboardPermissions,
  getMyDashboardPermissions,
  updateDashboardPermissions,
  listUsersWithDashboardPermissions,
} from '../controllers/dashboardPermission.controller.js';
import authMiddleware from '../middlewares/auth.middleware.js';
import requireRole from '../middlewares/role.middleware.js';
import { cacheResponse, invalidateCacheOnSuccess } from '../middlewares/cache.middleware.js';

// User's own dashboard permissions rarely change — long-TTL cache.
// Per-user cache key (built from req.user.id by cache.middleware.js) keeps
// each user's state isolated.
const dashPermsMeCache = cacheResponse({ ttlSeconds: 300, namespace: 'dash-perms-me' });
const bustDashPermsCache = invalidateCacheOnSuccess(['dash-perms-me|']);

export function createDashboardPermissionRouter({ authenticate = authMiddleware } = {}) {
  const router = express.Router();
  router.use(authenticate, (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  router.get('/me', dashPermsMeCache, getMyDashboardPermissions);
  router.use(requireRole('admin'));
  router.get('/users', listUsersWithDashboardPermissions);
  router.get('/:userId', getDashboardPermissions);
  router.put('/:userId', bustDashPermsCache, updateDashboardPermissions);
  return router;
}

export default createDashboardPermissionRouter();
