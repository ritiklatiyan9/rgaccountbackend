import express from 'express';
const router = express.Router();

import {
  listAllPending,
  getPendingCounts,
  approveEntry,
  rejectEntry,
  attachVoucher,
  bulkApprove,
  bulkReject,
  updateChequeStatus,
  listChequeEntries,
} from '../controllers/approval.controller.js';
import authMiddleware from '../middlewares/auth.middleware.js';
import requireRole from '../middlewares/role.middleware.js';
import requirePermission, { requireApprovalAccess } from '../middlewares/permission.middleware.js';
import { cacheResponse, invalidateCacheOnSuccess } from '../middlewares/cache.middleware.js';

const cachedApprovalRead = cacheResponse({ ttlSeconds: 30, namespace: 'approvals' });
// Never serve an earlier, broader cached response after workspace access is revoked.
const approvalReadCache = (req, res, next) => req.assignedApprovalsOnly ? next() : cachedApprovalRead(req, res, next);
// Approval mutations affect all modules (expenses, farmers, plots, cashflow, daybook, etc.)
const bustApprovalCache = invalidateCacheOnSuccess(['plots|', 'plots:pageData:', 'approvals|', '/approvals', '/expenses', 'expenses|', 'expenses:page:', 'imprest|', '/farmers', '/plots', '/cashflow', '/daybook', '/firms', '/registries', 'land-deals|', '/land-deals', 'misc-income|']);

// Direct assignments are accessible without the broad expense-approval grant.
router.use(authMiddleware);
router.use(requireRole('admin', 'sub_admin'));

router.get('/pending', requireApprovalAccess, approvalReadCache, listAllPending);
router.get('/counts', requireApprovalAccess, approvalReadCache, getPendingCounts);
router.put('/:id/approve', requireApprovalAccess, bustApprovalCache, approveEntry);
router.put('/:id/reject', requireApprovalAccess, bustApprovalCache, rejectEntry);
router.post('/bulk-approve', requireApprovalAccess, bustApprovalCache, bulkApprove);
router.post('/bulk-reject', requireApprovalAccess, bustApprovalCache, bulkReject);

router.use(requirePermission('expense_approval', 'read'));
router.get('/cheques', approvalReadCache, listChequeEntries);
router.put('/:id/voucher', bustApprovalCache, attachVoucher);
router.patch('/cheque-status', bustApprovalCache, updateChequeStatus);

export default router;
