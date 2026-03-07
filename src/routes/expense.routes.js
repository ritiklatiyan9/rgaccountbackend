import express from 'express';
const router = express.Router();

import {
  createExpense, listExpenses, getExpense,
  updateExpense, deleteExpense, getAutocomplete,
  listPendingExpenses, getStatusCounts,
  approveExpense, rejectExpense, bulkApproveExpenses,
} from '../controllers/expense.controller.js';
import authMiddleware from '../middlewares/auth.middleware.js';
import requireRole from '../middlewares/role.middleware.js';

// All expense routes require auth
router.use(authMiddleware);

// Standard expense CRUD
router.get('/', listExpenses);                            // ?site_id=X
router.get('/autocomplete', getAutocomplete);             // ?site_id=X
router.get('/pending', requireRole('admin'), listPendingExpenses);     // Admin: get pending expenses
router.get('/status-counts', requireRole('admin'), getStatusCounts);   // Admin: get status counts
router.get('/:id', getExpense);
router.post('/', requireRole('admin'), createExpense);
router.put('/:id', requireRole('admin'), updateExpense);
router.delete('/:id', requireRole('admin'), deleteExpense);

// Approval routes (admin only)
router.put('/:id/approve', requireRole('admin'), approveExpense);
router.put('/:id/reject', requireRole('admin'), rejectExpense);
router.post('/bulk-approve', requireRole('admin'), bulkApproveExpenses);

export default router;
