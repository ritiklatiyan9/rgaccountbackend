import express from 'express';
import authMiddleware from '../middlewares/auth.middleware.js';
import requireRole from '../middlewares/role.middleware.js';
import requirePermission from '../middlewares/permission.middleware.js';
import { cacheResponse, invalidateCacheOnSuccess } from '../middlewares/cache.middleware.js';
import {
  listDeals, getDeal, createDeal, updateDeal, deleteDeal, sellDeal,
  listPayments, createPayment, updatePayment, deletePayment,
} from '../controllers/landDeal.controller.js';

const router = express.Router();

// Land Profit is a sub-module of Farmers, so it rides the existing 'farmers' permission
// key — no new module to grant.
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
router.post('/', canWrite, bustCache, createDeal);

// Payment routes are declared before '/:id' so 'payments' is never read as an id.
router.get('/:id/payments', canRead, readCache, listPayments);
router.post('/:id/payments', canWrite, bustCache, createPayment);
router.put('/:id/payments/:paymentId', canUpdate, bustCache, updatePayment);
router.delete('/:id/payments/:paymentId', canDelete, bustCache, deletePayment);

router.post('/:id/sell', canUpdate, bustCache, sellDeal);
router.get('/:id', canRead, readCache, getDeal);
router.put('/:id', canUpdate, bustCache, updateDeal);
router.delete('/:id', canDelete, bustCache, deleteDeal);

export default router;
