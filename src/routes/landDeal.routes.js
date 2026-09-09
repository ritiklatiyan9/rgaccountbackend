import { transactionDateMiddleware } from '../services/transactionDate.service.js';
import express from 'express';
import authMiddleware from '../middlewares/auth.middleware.js';
import requireRole from '../middlewares/role.middleware.js';
import requirePermission from '../middlewares/permission.middleware.js';
import { cacheResponse, invalidateCacheOnSuccess } from '../middlewares/cache.middleware.js';
import {
  listDeals, getDeal, createDeal, updateDeal, deleteDeal, getLandProfit,
  listPayments, createPayment, updatePayment, deletePayment,
} from '../controllers/landDeal.controller.js';
import { getLandPartnerShares, saveLandPartnerShares } from '../controllers/landPartnerShare.controller.js';

const router = express.Router();

// Land Sale / Land Profit are sub-modules of Lands Payments, so they ride the existing
// 'farmers' permission key — no new module to grant.
router.use(authMiddleware, requireRole('admin', 'sub_admin'));

const readCache = cacheResponse({ ttlSeconds: 30, namespace: 'land-deals' });
// Receipts post to the ledger, so a write must also clear the farmer, daybook and
// balance-sheet caches (invalidateCacheOnSuccess always adds 'balance-sheet|').
const bustCache = invalidateCacheOnSuccess(['land-deals|', 'farmers|', '/daybook']);

const canRead = requirePermission('farmers', 'read');
const canWrite = requirePermission('farmers', 'write');
const canUpdate = requirePermission('farmers', 'update');
const canDelete = requirePermission('farmers', 'delete');

router.get('/', canRead, readCache, listDeals);
// Declared before '/:id' so 'profit' and 'payments' are never read as an id.
router.get('/profit', canRead, readCache, getLandProfit);
// A land's own partner split (Land Profit → Partners). Saving changes partner figures on
// Sites Profit too, so its cache is cleared as well. Admin-only like the site split.
router.get('/land/:farmerId/partners', canRead, readCache, getLandPartnerShares);
router.put('/land/:farmerId/partners', requireRole('admin'), invalidateCacheOnSuccess(['land-deals|', 'site-profit|']), saveLandPartnerShares);
router.post('/', canWrite, bustCache, transactionDateMiddleware, createDeal);

router.get('/:id/payments', canRead, readCache, listPayments);
router.post('/:id/payments', canWrite, bustCache, transactionDateMiddleware, createPayment);
router.put('/:id/payments/:paymentId', canUpdate, bustCache, transactionDateMiddleware, updatePayment);
router.delete('/:id/payments/:paymentId', canDelete, bustCache, deletePayment);

router.get('/:id', canRead, readCache, getDeal);
router.put('/:id', canUpdate, bustCache, transactionDateMiddleware, updateDeal);
router.delete('/:id', canDelete, bustCache, deleteDeal);

export default router;
