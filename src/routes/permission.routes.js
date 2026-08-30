import express from 'express';
const router = express.Router();

import { getPermissions, updatePermissions } from '../controllers/permission.controller.js';
import authMiddleware from '../middlewares/auth.middleware.js';
import requireRole from '../middlewares/role.middleware.js';
import { cacheResponse, invalidateCacheOnSuccess } from '../middlewares/cache.middleware.js';

const permissionReadCache = cacheResponse({ ttlSeconds: 30, namespace: 'permissions' });
// A row-scope grant/revocation must be visible immediately. Clear the affected
// financial read caches as well as the permission matrix; cache keys are
// user-specific, but an old response for that same user would otherwise live
// until its normal TTL expires.
const bustPermissionCache = invalidateCacheOnSuccess([
  'permissions|', 'dash-perms-me|', 'expenses|', 'daybook|', 'cashflow|',
  'commissions|', 'plot-commissions|', 'plots|', 'farmers|', 'firms|',
  'registries|', 'vendors|', 'management-analytics|',
]);

// All permission routes require authentication + admin role
router.use(authMiddleware, requireRole('admin'));

router.get('/:userId', permissionReadCache, getPermissions);
router.put('/:userId', bustPermissionCache, updatePermissions);

export default router;
