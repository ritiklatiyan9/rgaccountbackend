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

// All farmer routes require auth
router.use(authMiddleware);

// Farmer members (for registration dropdown) — must come before /:id
router.get('/members', listFarmerMembers);

// Farmer CRUD
router.get('/', listFarmers);                                     // ?site_id=X
router.get('/:id', getFarmer);
router.post('/', requireRole('admin'), createFarmer);
router.put('/:id', requireRole('admin'), updateFarmer);
router.delete('/:id', requireRole('admin'), deleteFarmer);

// Farmer Payments (installments)
router.get('/:farmerId/payments', listPayments);
router.post('/:farmerId/payments', requireRole('admin'), createPayment);
router.put('/:farmerId/payments/:paymentId', requireRole('admin'), updatePayment);
router.delete('/:farmerId/payments/:paymentId', requireRole('admin'), deletePayment);

export default router;
