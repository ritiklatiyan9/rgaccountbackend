import express from 'express';
const router = express.Router();

import { listPartyLinks, savePartyLink, PARTY_TARGETS } from '../controllers/transactionParty.controller.js';
import authMiddleware from '../middlewares/auth.middleware.js';
import requireRole from '../middlewares/role.middleware.js';
import requirePermission from '../middlewares/permission.middleware.js';
import requirePlotSiteAccess from '../middlewares/plotSiteAccess.middleware.js';
import { cacheResponse, invalidateCacheOnSuccess } from '../middlewares/cache.middleware.js';

router.use(authMiddleware);
router.use(requireRole('admin', 'sub_admin'));

// Permission module depends on the target — resolve it, then delegate to the
// standard middleware, exactly as the signature endpoint does.
const requireTargetPermission = (action) => (req, res, next) => {
  const target = PARTY_TARGETS[req.params.target];
  if (!target) return res.status(400).json({ message: 'Unknown transaction target' });
  if (target.adminOnly) return requireRole('admin')(req, res, next);
  return requirePermission(target.perm, action)(req, res, next);
};

// Read is one call for the whole table, so per-target permission filtering
// happens inside the controller rather than as all-or-nothing middleware.
router.get(
  '/',
  requirePlotSiteAccess({ entity: 'site', source: 'query', key: 'site_id' }),
  cacheResponse({ ttlSeconds: 30, namespace: 'transaction-parties' }),
  listPartyLinks
);

router.put(
  '/:target/:id',
  requireTargetPermission('update'),
  invalidateCacheOnSuccess(['transaction-parties|', 'expenses:page:', 'expenses:breakdown:']),
  savePartyLink
);

export default router;
