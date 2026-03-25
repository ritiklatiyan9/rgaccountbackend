import express from 'express';
const router = express.Router();

import {
  createAllocation,
  listAllocations,
  cancelAllocation,
  getPendingReceipts,
  confirmReceipt,
  getBalance,
  getLedger,
  getAllBalances,
  createExpenseFromImprest,
  createExpenseRequest,
  listExpenseRequests,
  approveExpenseRequest,
  rejectExpenseRequest,
  adjustBalance,
} from '../controllers/imprest.controller.js';
import authMiddleware from '../middlewares/auth.middleware.js';
import requireRole from '../middlewares/role.middleware.js';
import { cacheResponse, invalidateCacheOnSuccess } from '../middlewares/cache.middleware.js';

const imprestReadCache = cacheResponse({ ttlSeconds: 30, namespace: 'imprest' });
const bustImprestCache = invalidateCacheOnSuccess(['/imprest']);

// All imprest routes require auth
router.use(authMiddleware);

// ── Balance & Ledger (any authenticated user) ──
router.get('/balance', imprestReadCache, getBalance);
router.get('/ledger', imprestReadCache, getLedger);

// ── Pending receipts (sub-admin confirms received funds) ──
router.get('/pending-receipts', imprestReadCache, getPendingReceipts);
router.put('/allocations/:id/confirm', bustImprestCache, confirmReceipt);

// ── Sub-admin creates expense from imprest ──
router.post('/expense', bustImprestCache, createExpenseFromImprest);

// ── Expense requests (overdraft flow) ──
router.get('/expense-requests', imprestReadCache, listExpenseRequests);
router.post('/expense-requests', bustImprestCache, createExpenseRequest);

// ── Admin-only routes ──
router.post('/allocations', requireRole('admin'), bustImprestCache, createAllocation);
router.get('/allocations', requireRole('admin'), imprestReadCache, listAllocations);
router.delete('/allocations/:id', requireRole('admin'), bustImprestCache, cancelAllocation);
router.get('/all-balances', requireRole('admin'), imprestReadCache, getAllBalances);
router.post('/adjust', requireRole('admin'), bustImprestCache, adjustBalance);

// ── Admin approve/reject expense requests ──
router.put('/expense-requests/:id/approve', requireRole('admin'), bustImprestCache, approveExpenseRequest);
router.put('/expense-requests/:id/reject', requireRole('admin'), bustImprestCache, rejectExpenseRequest);

export default router;
