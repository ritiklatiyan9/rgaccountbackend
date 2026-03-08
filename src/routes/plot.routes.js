import express from 'express';
const router = express.Router();

import {
  createPlot, listPlots, getPlot, updatePlot, deletePlot,
  createPayment, listPayments, getPayment, updatePayment, deletePayment,
  getAutocomplete,
} from '../controllers/plot.controller.js';
import authMiddleware from '../middlewares/auth.middleware.js';
import requireRole from '../middlewares/role.middleware.js';
import requirePermission from '../middlewares/permission.middleware.js';

// All plot routes require auth
router.use(authMiddleware);

// ── Plot endpoints ──
router.get('/', requireRole('admin', 'sub_admin'), requirePermission('plot_payments', 'read'), listPlots);                                        // ?site_id=X
router.get('/autocomplete', requireRole('admin', 'sub_admin'), requirePermission('plot_payments', 'read'), getAutocomplete);                      // ?site_id=X
router.get('/:id', requireRole('admin', 'sub_admin'), requirePermission('plot_payments', 'read'), getPlot);
router.post('/', requireRole('admin', 'sub_admin'), requirePermission('plot_payments', 'write'), createPlot);
router.put('/:id', requireRole('admin', 'sub_admin'), requirePermission('plot_payments', 'update'), updatePlot);
router.delete('/:id', requireRole('admin', 'sub_admin'), requirePermission('plot_payments', 'delete'), deletePlot);

// ── Payment endpoints ──
router.get('/payments/list', requireRole('admin', 'sub_admin'), requirePermission('plot_payments', 'read'), listPayments);                        // ?plot_id=X
router.get('/payments/:id', requireRole('admin', 'sub_admin'), requirePermission('plot_payments', 'read'), getPayment);
router.post('/payments', requireRole('admin', 'sub_admin'), requirePermission('plot_payments', 'write'), createPayment);
router.put('/payments/:id', requireRole('admin', 'sub_admin'), requirePermission('plot_payments', 'update'), updatePayment);
router.delete('/payments/:id', requireRole('admin', 'sub_admin'), requirePermission('plot_payments', 'delete'), deletePayment);

export default router;
