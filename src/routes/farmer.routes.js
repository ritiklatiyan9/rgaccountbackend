import express from 'express';
const router = express.Router();

import {
  createFarmer,
  listFarmers,
  getFarmer,
  updateFarmer,
  deleteFarmer,
  createPayment,
  listPayments,
  updatePayment,
  deletePayment,
  listFarmerMembers,
} from '../controllers/farmer.controller.js';
import authMiddleware from '../middlewares/auth.middleware.js';
import requireRole from '../middlewares/role.middleware.js';
import requirePermission from '../middlewares/permission.middleware.js';

// All farmer routes require auth
router.use(authMiddleware);

// Farmer members (for registration dropdown) — must come before /:id
router.get('/members', listFarmerMembers);

// Farmer CRUD
router.get('/', requireRole('admin', 'sub_admin'), requirePermission('farmers', 'read'), listFarmers);                                     // ?site_id=X
router.get('/:id', requireRole('admin', 'sub_admin'), requirePermission('farmers', 'read'), getFarmer);
router.post('/', requireRole('admin', 'sub_admin'), requirePermission('farmers', 'write'), createFarmer);
router.put('/:id', requireRole('admin', 'sub_admin'), requirePermission('farmers', 'update'), updateFarmer);
router.delete('/:id', requireRole('admin', 'sub_admin'), requirePermission('farmers', 'delete'), deleteFarmer);

// Farmer Payments (installments)
router.get('/:farmerId/payments', requireRole('admin', 'sub_admin'), requirePermission('farmers', 'read'), listPayments);
router.post('/:farmerId/payments', requireRole('admin', 'sub_admin'), requirePermission('farmers', 'write'), createPayment);
router.put('/:farmerId/payments/:paymentId', requireRole('admin', 'sub_admin'), requirePermission('farmers', 'update'), updatePayment);
router.delete('/:farmerId/payments/:paymentId', requireRole('admin', 'sub_admin'), requirePermission('farmers', 'delete'), deletePayment);

export default router;
