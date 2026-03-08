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
import requirePermission from '../middlewares/permission.middleware.js';

// All expense routes require auth
router.use(authMiddleware);

// Standard expense CRUD
router.get('/', requireRole('admin', 'sub_admin'), requirePermission('expenses', 'read'), listExpenses);                            // ?site_id=X
router.get('/autocomplete', requireRole('admin', 'sub_admin'), requirePermission('expenses', 'read'), getAutocomplete);             // ?site_id=X
router.get('/pending', requireRole('admin'), listPendingExpenses);     // Admin: get pending expenses
router.get('/status-counts', requireRole('admin'), getStatusCounts);   // Admin: get status counts
router.get('/:id', requireRole('admin', 'sub_admin'), requirePermission('expenses', 'read'), getExpense);
router.post('/', requireRole('admin', 'sub_admin'), requirePermission('expenses', 'write'), createExpense);
router.put('/:id', requireRole('admin', 'sub_admin'), requirePermission('expenses', 'update'), updateExpense);
router.delete('/:id', requireRole('admin', 'sub_admin'), requirePermission('expenses', 'delete'), deleteExpense);

// Approval routes (admin only)
router.put('/:id/approve', requireRole('admin'), approveExpense);
router.put('/:id/reject', requireRole('admin'), rejectExpense);
router.post('/bulk-approve', requireRole('admin'), bulkApproveExpenses);

export default router;
