import express from 'express';
const router = express.Router();

import {
  createFirm, listFirms, getFirm, updateFirm, deleteFirm,
  createTransaction, createFirmToFirmTransfer, listTransactions, getTransaction, updateTransaction, deleteTransaction,
  bulkCreateTransactions, getAutocomplete, listCashFlowLedgersForFirm, getFirmHistoryAnalytics,
} from '../controllers/firm.controller.js';
import authMiddleware from '../middlewares/auth.middleware.js';
import requireRole from '../middlewares/role.middleware.js';
import requirePermission from '../middlewares/permission.middleware.js';
import { cacheResponse, invalidateCacheOnSuccess } from '../middlewares/cache.middleware.js';

const firmReadCache = cacheResponse({ ttlSeconds: 30, namespace: 'firms' });
const bustFirmCache = invalidateCacheOnSuccess(['/firms']);

// All firm routes require auth
router.use(authMiddleware);

// ── Firm endpoints ──
router.get('/', requireRole('admin', 'sub_admin'), requirePermission('firm_transactions', 'read'), firmReadCache, listFirms);                           // ?site_id=X
router.get('/list', requireRole('admin', 'sub_admin'), requirePermission('firm_transactions', 'read'), listFirms);                        // ?site_id=X
router.get('/autocomplete', requireRole('admin', 'sub_admin'), requirePermission('firm_transactions', 'read'), getAutocomplete);                     // ?site_id=X
router.get('/cashflow-ledgers', requireRole('admin', 'sub_admin'), requirePermission('firm_transactions', 'read'), listCashFlowLedgersForFirm);     // ?site_id=X
router.get('/history/analytics', requireRole('admin', 'sub_admin'), requirePermission('firm_transactions', 'read'), getFirmHistoryAnalytics);        // ?site_id=X
router.get('/:id', requireRole('admin', 'sub_admin'), requirePermission('firm_transactions', 'read'), getFirm);
router.post('/', requireRole('admin', 'sub_admin'), requirePermission('firm_transactions', 'write'), createFirm);
router.put('/:id', requireRole('admin', 'sub_admin'), requirePermission('firm_transactions', 'update'), updateFirm);
router.delete('/:id', requireRole('admin', 'sub_admin'), requirePermission('firm_transactions', 'delete'), deleteFirm);

// ── Transaction endpoints ──
router.get('/transactions/list', requireRole('admin', 'sub_admin'), requirePermission('firm_transactions', 'read'), listTransactions);               // ?firm_id=X
router.post('/transactions/firm-to-firm', requireRole('admin', 'sub_admin'), requirePermission('firm_transactions', 'write'), createFirmToFirmTransfer);
router.get('/transactions/:id', requireRole('admin', 'sub_admin'), requirePermission('firm_transactions', 'read'), getTransaction);
router.post('/transactions', requireRole('admin', 'sub_admin'), requirePermission('firm_transactions', 'write'), createTransaction);
router.post('/transactions/bulk', requireRole('admin', 'sub_admin'), requirePermission('firm_transactions', 'write'), bulkCreateTransactions);     // Bulk import
router.put('/transactions/:id', requireRole('admin', 'sub_admin'), requirePermission('firm_transactions', 'update'), updateTransaction);
router.delete('/transactions/:id', requireRole('admin', 'sub_admin'), requirePermission('firm_transactions', 'delete'), deleteTransaction);

export default router;
