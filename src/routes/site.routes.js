import express from 'express';
const router = express.Router();

import { createSite, listSites, getSite, updateSite, deleteSite } from '../controllers/site.controller.js';
import {
  getDirectorOverview,
  getDirectorPerson,
  streamDirectorAssistant,
} from '../controllers/siteDirector.controller.js';
import {
  getSiteProfitShares,
  saveSiteProfitShares,
} from '../controllers/sitePartnerShare.controller.js';
import authMiddleware from '../middlewares/auth.middleware.js';
import requireRole from '../middlewares/role.middleware.js';
import { cacheResponse, invalidateCacheOnSuccess } from '../middlewares/cache.middleware.js';

const siteReadCache = cacheResponse({ ttlSeconds: 60, namespace: 'sites' });
const bustSiteCache = invalidateCacheOnSuccess(['/sites']);

// All site routes require auth
router.use(authMiddleware);

// Portfolio-wide finance intelligence. Keep these named routes above /:id.
router.get('/director/overview', requireRole('admin'), getDirectorOverview);
router.get('/director/person', requireRole('admin'), getDirectorPerson);
router.post('/director/assistant', requireRole('admin'), streamDirectorAssistant);

router.get('/', siteReadCache, listSites);                              // admin + sub_admin
// Profit distribution (partner shares). Above /:id is not required — the path
// segment differs — but keeps the director block together.
// Profit is recomputed from the whole ledger on every call, so cache it briefly per
// user. The page's Refresh button adds a revision param, which is a new cache key.
const profitCache = cacheResponse({ ttlSeconds: 120, namespace: 'site-profit' });
router.get('/:id/profit-shares', requireRole('admin'), profitCache, getSiteProfitShares);
router.put('/:id/profit-shares', requireRole('admin'), invalidateCacheOnSuccess(['site-profit|']), saveSiteProfitShares);

router.get('/:id', siteReadCache, getSite);                             // admin + sub_admin (access-checked)
router.post('/', requireRole('admin'), bustSiteCache, createSite);      // admin only
router.put('/:id', requireRole('admin'), bustSiteCache, updateSite);    // admin only
router.delete('/:id', requireRole('admin'), bustSiteCache, deleteSite); // admin only

export default router;
