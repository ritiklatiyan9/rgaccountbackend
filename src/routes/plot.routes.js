import express from 'express';
const router = express.Router();

import {
  createPlot, listPlots, getPlot, updatePlot, deletePlot,
  createPayment, listPayments, getPayment, updatePayment, deletePayment,
  getAutocomplete,
} from '../controllers/plot.controller.js';
import {
  updateInstallmentSettings, listInstallments, createInstallments,
  updateInstallment, deleteInstallment,
  recordInstallmentPayment, listInstallmentPayments,
  paymentManagementList, paymentReminders, paymentAnalytics,
} from '../controllers/installment.controller.js';
import authMiddleware from '../middlewares/auth.middleware.js';
import requireRole from '../middlewares/role.middleware.js';
import requirePermission from '../middlewares/permission.middleware.js';
import { cacheResponse, invalidateCacheOnSuccess } from '../middlewares/cache.middleware.js';

// All plot routes require auth
router.use(authMiddleware);

const plotReadCache = cacheResponse({ ttlSeconds: 45, namespace: 'plots' });
// Autocomplete (members + plot-payment fields like buyer_name/payment_from)
// rarely changes; long-TTL meta cache that survives plot/payment writes.
const plotMetaCache = cacheResponse({ ttlSeconds: 300, namespace: 'plots-meta' });
// Anchored prefix so 'plots-meta|...' isn't busted by writes.
const bustPlotCache = invalidateCacheOnSuccess(['plots|', '/daybook']);

// ── Plot endpoints ──
router.get('/', requireRole('admin', 'sub_admin'), requirePermission('plot_payments', 'read'), plotReadCache, listPlots);                                        // ?site_id=X
router.get('/autocomplete', requireRole('admin', 'sub_admin'), requirePermission('plot_payments', 'read'), plotMetaCache, getAutocomplete);                      // ?site_id=X
router.get('/payment-management', requireRole('admin', 'sub_admin'), requirePermission('plot_payments', 'read'), plotReadCache, paymentManagementList);           // ?site_id=X
router.get('/payment-reminders', requireRole('admin', 'sub_admin'), requirePermission('plot_payments', 'read'), plotReadCache, paymentReminders);                  // ?site_id=X&page=1&limit=10
router.get('/payment-analytics', requireRole('admin', 'sub_admin'), requirePermission('plot_payments', 'read'), plotReadCache, paymentAnalytics);                   // ?site_id=X&mode=...
router.get('/:id', requireRole('admin', 'sub_admin'), requirePermission('plot_payments', 'read'), plotReadCache, getPlot);
router.post('/', requireRole('admin', 'sub_admin'), requirePermission('plot_payments', 'write'), bustPlotCache, createPlot);
router.put('/:id', requireRole('admin', 'sub_admin'), requirePermission('plot_payments', 'update'), bustPlotCache, updatePlot);
router.delete('/:id', requireRole('admin', 'sub_admin'), requirePermission('plot_payments', 'delete'), bustPlotCache, deletePlot);

// ── Payment endpoints ──
router.get('/payments/list', requireRole('admin', 'sub_admin'), requirePermission('plot_payments', 'read'), plotReadCache, listPayments);                        // ?plot_id=X
router.get('/payments/:id', requireRole('admin', 'sub_admin'), requirePermission('plot_payments', 'read'), plotReadCache, getPayment);
router.post('/payments', requireRole('admin', 'sub_admin'), requirePermission('plot_payments', 'write'), bustPlotCache, createPayment);
router.put('/payments/:id', requireRole('admin', 'sub_admin'), requirePermission('plot_payments', 'update'), bustPlotCache, updatePayment);
router.delete('/payments/:id', requireRole('admin', 'sub_admin'), requirePermission('plot_payments', 'delete'), bustPlotCache, deletePayment);

// ── Installment management endpoints ──
router.get('/:id/installments', requireRole('admin', 'sub_admin'), requirePermission('plot_payments', 'read'), plotReadCache, listInstallments);
router.post('/:id/installments', requireRole('admin', 'sub_admin'), requirePermission('plot_payments', 'write'), bustPlotCache, createInstallments);
router.put('/installments/:instId', requireRole('admin', 'sub_admin'), requirePermission('plot_payments', 'update'), bustPlotCache, updateInstallment);
router.delete('/installments/:instId', requireRole('admin', 'sub_admin'), requirePermission('plot_payments', 'delete'), bustPlotCache, deleteInstallment);
router.put('/:id/installment-settings', requireRole('admin', 'sub_admin'), requirePermission('plot_payments', 'update'), bustPlotCache, updateInstallmentSettings);
router.post('/:id/installment-payment', requireRole('admin', 'sub_admin'), requirePermission('plot_payments', 'write'), bustPlotCache, recordInstallmentPayment);
router.get('/:id/installment-payments', requireRole('admin', 'sub_admin'), requirePermission('plot_payments', 'read'), plotReadCache, listInstallmentPayments);

export default router;
