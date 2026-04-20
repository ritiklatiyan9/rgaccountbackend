import express from 'express';

import {
  addVendorPayment,
  createVendorCommitment,
  createVendorHead,
  deleteVendorHead,
  deleteVendorPayment,
  distributePaymentToItems,
  getVendorCommitmentDetail,
  getVendorPaymentReceipt,
  getVendorUsers,
  listAllInventoryItems,
  deleteVendorCommitment,
  listVendorCommitments,
  listVendorHeads,
  updateVendorCommitment,
  updateVendorCommitmentStatus,
  updateVendorPayment,
  updateVendorHead,
} from '../controllers/vendor.controller.js';
import {
  listInventoryOrders,
  getInventoryOrderDetail,
  createInventoryOrder,
  updateInventoryOrder,
  deleteInventoryOrder,
  addInventoryPayment,
  deleteInventoryPayment,
  listInventoryCategories,
  getInventoryStockSummary,
} from '../controllers/vendorInventory.controller.js';
import authMiddleware from '../middlewares/auth.middleware.js';
import requireRole from '../middlewares/role.middleware.js';
import requirePermission from '../middlewares/permission.middleware.js';
import { cacheResponse, invalidateCacheOnSuccess } from '../middlewares/cache.middleware.js';

const router = express.Router();

const vendorReadCache = cacheResponse({ ttlSeconds: 30, namespace: 'vendors' });
const bustVendorCache = invalidateCacheOnSuccess(['/vendors']);

router.use(authMiddleware);
router.use(requireRole('admin', 'sub_admin'));

router.get('/users', requirePermission('vendors', 'read'), vendorReadCache, getVendorUsers);
router.get('/heads', requirePermission('vendors', 'read'), vendorReadCache, listVendorHeads);
router.post('/heads', requirePermission('vendors', 'write'), bustVendorCache, createVendorHead);
router.put('/heads/:id', requirePermission('vendors', 'update'), bustVendorCache, updateVendorHead);
router.delete('/heads/:id', requirePermission('vendors', 'delete'), bustVendorCache, deleteVendorHead);

router.get('/commitments', requirePermission('vendors', 'read'), vendorReadCache, listVendorCommitments);
router.get('/inventory-all', requirePermission('vendors', 'read'), vendorReadCache, listAllInventoryItems);
router.get('/commitments/:id', requirePermission('vendors', 'read'), vendorReadCache, getVendorCommitmentDetail);
router.get('/payments/:paymentId/receipt', requirePermission('vendors', 'read'), vendorReadCache, getVendorPaymentReceipt);
router.post('/commitments', requirePermission('vendors', 'write'), bustVendorCache, createVendorCommitment);
router.put('/commitments/:id', requirePermission('vendors', 'update'), bustVendorCache, updateVendorCommitment);
router.delete('/commitments/:id', requirePermission('vendors', 'delete'), bustVendorCache, deleteVendorCommitment);
router.put('/commitments/:id/status', requirePermission('vendors', 'update'), bustVendorCache, updateVendorCommitmentStatus);
router.post('/commitments/:id/payments', requirePermission('vendors', 'write'), bustVendorCache, addVendorPayment);
router.post('/commitments/:id/distribute-payment', requirePermission('vendors', 'write'), bustVendorCache, distributePaymentToItems);
router.put('/payments/:paymentId', requirePermission('vendors', 'update'), bustVendorCache, updateVendorPayment);
router.delete('/payments/:paymentId', requirePermission('vendors', 'delete'), bustVendorCache, deleteVendorPayment);

// ── Inventory ──────────────────────────────────────────────────────────────
router.get('/inventory/categories', requirePermission('vendors', 'read'), vendorReadCache, listInventoryCategories);
router.get('/inventory/stock-summary', requirePermission('vendors', 'read'), vendorReadCache, getInventoryStockSummary);
router.get('/inventory', requirePermission('vendors', 'read'), vendorReadCache, listInventoryOrders);
router.post('/inventory', requirePermission('vendors', 'write'), bustVendorCache, createInventoryOrder);
router.get('/inventory/:id', requirePermission('vendors', 'read'), vendorReadCache, getInventoryOrderDetail);
router.put('/inventory/:id', requirePermission('vendors', 'update'), bustVendorCache, updateInventoryOrder);
router.delete('/inventory/:id', requirePermission('vendors', 'delete'), bustVendorCache, deleteInventoryOrder);

router.post('/inventory/:id/payments', requirePermission('vendors', 'write'), bustVendorCache, addInventoryPayment);
router.delete('/inventory/inv-payments/:paymentId', requirePermission('vendors', 'delete'), bustVendorCache, deleteInventoryPayment);

export default router;
