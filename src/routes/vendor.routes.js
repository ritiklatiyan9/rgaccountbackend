import express from 'express';

import {
  addVendorPayment,
  createVendorCommitment,
  createVendorHead,
  deleteVendorPayment,
  getVendorCommitmentDetail,
  getVendorPaymentReceipt,
  getVendorUsers,
  listVendorCommitments,
  listVendorHeads,
  updateVendorCommitmentStatus,
  updateVendorPayment,
  updateVendorHead,
} from '../controllers/vendor.controller.js';
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

router.get('/commitments', requirePermission('vendors', 'read'), vendorReadCache, listVendorCommitments);
router.get('/commitments/:id', requirePermission('vendors', 'read'), vendorReadCache, getVendorCommitmentDetail);
router.get('/payments/:paymentId/receipt', requirePermission('vendors', 'read'), vendorReadCache, getVendorPaymentReceipt);
router.post('/commitments', requirePermission('vendors', 'write'), bustVendorCache, createVendorCommitment);
router.put('/commitments/:id/status', requirePermission('vendors', 'update'), bustVendorCache, updateVendorCommitmentStatus);
router.post('/commitments/:id/payments', requirePermission('vendors', 'write'), bustVendorCache, addVendorPayment);
router.put('/payments/:paymentId', requirePermission('vendors', 'update'), bustVendorCache, updateVendorPayment);
router.delete('/payments/:paymentId', requirePermission('vendors', 'delete'), bustVendorCache, deleteVendorPayment);

export default router;
