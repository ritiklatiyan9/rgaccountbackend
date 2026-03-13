import express from 'express';

import {
  addVendorPayment,
  createVendorCommitment,
  createVendorHead,
  deleteVendorPayment,
  getVendorCommitmentDetail,
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

const router = express.Router();

router.use(authMiddleware);
router.use(requireRole('admin', 'sub_admin'));

router.get('/users', requirePermission('vendors', 'read'), getVendorUsers);
router.get('/heads', requirePermission('vendors', 'read'), listVendorHeads);
router.post('/heads', requirePermission('vendors', 'write'), createVendorHead);
router.put('/heads/:id', requirePermission('vendors', 'update'), updateVendorHead);

router.get('/commitments', requirePermission('vendors', 'read'), listVendorCommitments);
router.get('/commitments/:id', requirePermission('vendors', 'read'), getVendorCommitmentDetail);
router.post('/commitments', requirePermission('vendors', 'write'), createVendorCommitment);
router.put('/commitments/:id/status', requirePermission('vendors', 'update'), updateVendorCommitmentStatus);
router.post('/commitments/:id/payments', requirePermission('vendors', 'write'), addVendorPayment);
router.put('/payments/:paymentId', requirePermission('vendors', 'update'), updateVendorPayment);
router.delete('/payments/:paymentId', requirePermission('vendors', 'delete'), deleteVendorPayment);

export default router;
