import express from 'express';
const router = express.Router();

import {
  getPlotsForCommission,
  createPlotCommission,
  listPlotCommissions,
  getPlotCommissionDetail,
  createPlotCommissionPayment,
  getPlotCommissionAnalytics,
  updatePlotCommission,
  deletePlotCommission
} from '../controllers/plotCommissionV2.controller.js';
import authMiddleware from '../middlewares/auth.middleware.js';
import requireRole from '../middlewares/role.middleware.js';
import requirePermission from '../middlewares/permission.middleware.js';

// All routes require auth
router.use(authMiddleware);

// These permissions use the existing 'commissions' module permission identifier for backward compatibility/simplicity
router.get('/plots', requireRole('admin', 'sub_admin'), requirePermission('commissions', 'read'), getPlotsForCommission);
router.post('/create', requireRole('admin', 'sub_admin'), requirePermission('commissions', 'write'), createPlotCommission);
router.get('/list', requireRole('admin', 'sub_admin'), requirePermission('commissions', 'read'), listPlotCommissions);
router.get('/:id', requireRole('admin', 'sub_admin'), requirePermission('commissions', 'read'), getPlotCommissionDetail);
router.put('/:id', requireRole('admin', 'sub_admin'), requirePermission('commissions', 'write'), updatePlotCommission);
router.delete('/:id', requireRole('admin', 'sub_admin'), requirePermission('commissions', 'write'), deletePlotCommission);
router.post('/payment', requireRole('admin', 'sub_admin'), requirePermission('commissions', 'write'), createPlotCommissionPayment);
router.get('/analytics/:id', requireRole('admin', 'sub_admin'), requirePermission('commissions', 'read'), getPlotCommissionAnalytics);

export default router;
