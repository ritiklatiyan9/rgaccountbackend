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

// All imprest routes require auth
router.use(authMiddleware);

// ── Balance & Ledger (any authenticated user) ──
router.get('/balance', getBalance);
router.get('/ledger', getLedger);

// ── Pending receipts (sub-admin confirms received funds) ──
router.get('/pending-receipts', getPendingReceipts);
router.put('/allocations/:id/confirm', confirmReceipt);

// ── Sub-admin creates expense from imprest ──
router.post('/expense', createExpenseFromImprest);

// ── Expense requests (overdraft flow) ──
router.get('/expense-requests', listExpenseRequests);
router.post('/expense-requests', createExpenseRequest);

// ── Admin-only routes ──
router.post('/allocations', requireRole('admin'), createAllocation);
router.get('/allocations', requireRole('admin'), listAllocations);
router.delete('/allocations/:id', requireRole('admin'), cancelAllocation);
router.get('/all-balances', requireRole('admin'), getAllBalances);
router.post('/adjust', requireRole('admin'), adjustBalance);

// ── Admin approve/reject expense requests ──
router.put('/expense-requests/:id/approve', requireRole('admin'), approveExpenseRequest);
router.put('/expense-requests/:id/reject', requireRole('admin'), rejectExpenseRequest);

export default router;
