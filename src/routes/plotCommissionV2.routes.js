import { transactionDateMiddleware } from '../services/transactionDate.service.js';
import express from 'express';


import {
  getPlotsForCommission,
  getCommissionReceivers,
  getCommissionAllocations,
  saveCommissionAllocations,
  createPlotCommission,
  listPlotCommissions,
  getPlotCommissionDetail,
  getPlotCommissionByPlot,
  createPlotCommissionPayment,
  updatePlotCommissionPayment,
  deletePlotCommissionPayment,
  bulkDeletePlotCommissionPayments,
  getPlotCommissionAnalytics,
  updatePlotCommission,
  deletePlotCommission,
  listLandCommissions,
  getCommissionBySubject,
  listAllSitesCommissions,
} from '../controllers/plotCommissionV2.controller.js';
import authMiddleware from '../middlewares/auth.middleware.js';
import requireRole from '../middlewares/role.middleware.js';
import requirePermission from '../middlewares/permission.middleware.js';
import { cacheResponse, invalidateCacheOnSuccess } from '../middlewares/cache.middleware.js';
import { requireOverallSiteScope } from '../middlewares/overallSiteScope.middleware.js';
import pool from '../config/db.js';
import { assertAllocationSite, positiveId } from '../services/commissionAllocations.service.js';

const plotCommissionReadCache = cacheResponse({ ttlSeconds: 30, namespace: 'plot-commissions' });
const authorizeCommissionSiteHit = async req => {
  await assertAllocationSite(pool,req.user,positiveId(req.query.site_id));
  return true;
};
export const commissionAllocationReadCache = cacheResponse({ttlSeconds:30,namespace:'plot-commissions',authorizeHit:authorizeCommissionSiteHit});
// /plots is just the list of plots a commission can be assigned to — it
// rarely changes, so it gets its own namespace with a longer TTL and is
// NOT busted by every commission/payment write.
const plotsForCommissionCache = cacheResponse({ ttlSeconds: 300, namespace: 'plot-commissions-plots', authorizeHit: authorizeCommissionSiteHit });
// Anchored prefix so the dedicated cache survives writes.
const bustPlotCommissionCache = invalidateCacheOnSuccess(['plot-commissions|', 'members|']);

export function createPlotCommissionRouter({ authenticate = authMiddleware } = {}) {
const router = express.Router();
// All routes require auth
router.use(authenticate);
router.get('/receivers', requireRole('admin', 'sub_admin'), requirePermission('commissions', 'read'), commissionAllocationReadCache, getCommissionReceivers);
router.get('/allocations', requireRole('admin', 'sub_admin'), requirePermission('commissions', 'read'), commissionAllocationReadCache, getCommissionAllocations);
router.post('/allocations', requireRole('admin', 'sub_admin'), requirePermission('commissions', 'write'),
  invalidateCacheOnSuccess(['plot-commissions|','plot-commissions-plots|','members|']), saveCommissionAllocations);

// These permissions use the existing 'commissions' module permission identifier for backward compatibility/simplicity
router.get('/plots', requireRole('admin', 'sub_admin'), requirePermission('commissions', 'read'), plotsForCommissionCache, getPlotsForCommission);
router.post('/create', requireRole('admin', 'sub_admin'), requirePermission('commissions', 'write'), bustPlotCommissionCache, createPlotCommission);
// Explicit overview access retains the register's entry scope and assigned sites.
router.get('/portfolio', requireRole('admin', 'sub_admin'), requirePermission('commissions', 'read'), requirePermission('all_sites_commission', 'read'), requireOverallSiteScope, plotCommissionReadCache, listAllSitesCommissions);
router.get('/list', requireRole('admin', 'sub_admin'), requirePermission('commissions', 'read'), plotCommissionReadCache, listPlotCommissions);
// Land Commission (subject = land purchase / land sale) — same engine, same permission key.
router.get('/land', requireRole('admin', 'sub_admin'), requirePermission('commissions', 'read'), plotCommissionReadCache, listLandCommissions);
router.get('/subject/:kind/:id', requireRole('admin', 'sub_admin'), requirePermission('commissions', 'read'), plotCommissionReadCache, getCommissionBySubject);

// Payment routes (more specific, must come before /:id routes)
router.post('/payment', requireRole('admin', 'sub_admin'), requirePermission('commissions', 'write'), bustPlotCommissionCache, transactionDateMiddleware, createPlotCommissionPayment);
router.put('/payment/:id', requireRole('admin', 'sub_admin'), requirePermission('commissions', 'update'), bustPlotCommissionCache, transactionDateMiddleware, updatePlotCommissionPayment);
router.delete('/payment/:id', requireRole('admin', 'sub_admin'), requirePermission('commissions', 'delete'), bustPlotCommissionCache, deletePlotCommissionPayment);
router.post('/payment/bulk-delete', requireRole('admin', 'sub_admin'), requirePermission('commissions', 'delete'), bustPlotCommissionCache, bulkDeletePlotCommissionPayments);

// Analytics route (more specific, must come before /:id routes)
router.get('/analytics/:id', requireRole('admin', 'sub_admin'), requirePermission('commissions', 'read'), plotCommissionReadCache, getPlotCommissionAnalytics);

// Plot-level detail route (all commissions for a plot)
router.get('/plot/:plotId', requireRole('admin', 'sub_admin'), requirePermission('commissions', 'read'), commissionAllocationReadCache, getPlotCommissionByPlot);

// Master commission routes (less specific, come last)
router.get('/:id', requireRole('admin', 'sub_admin'), requirePermission('commissions', 'read'), plotCommissionReadCache, getPlotCommissionDetail);
router.put('/:id', requireRole('admin', 'sub_admin'), requirePermission('commissions', 'update'), bustPlotCommissionCache, updatePlotCommission);
router.delete('/:id', requireRole('admin', 'sub_admin'), requirePermission('commissions', 'delete'), bustPlotCommissionCache, deletePlotCommission);

return router;
}
export default createPlotCommissionRouter();
