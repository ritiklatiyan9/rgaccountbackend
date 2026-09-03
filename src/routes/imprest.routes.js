import express from 'express';
const router = express.Router();

import {
  createAllocation,
  listAllocations,
  cancelAllocation,
  getPendingReceipts,
  confirmReceipt,
  declineReceipt,
  getBalance,
  getLedger,
  getAllBalances,
  createExpenseFromImprest,
  createExpenseRequest,
  listExpenseRequests,
  approveExpenseRequest,
  rejectExpenseRequest,
  adjustBalance,
  createReturn,
  listReturns,
  getPendingReturns,
  acceptReturn,
  rejectReturn,
  listTransferPeers,
  createTransfer,
  listTransfers,
  getSiteBalance,
} from '../controllers/imprest.controller.js';
import authMiddleware from '../middlewares/auth.middleware.js';
import requireRole from '../middlewares/role.middleware.js';
import requirePermission from '../middlewares/permission.middleware.js';
import requireImprestSiteAccess, { requireImprestParticipant } from '../middlewares/imprestSiteAccess.middleware.js';
import { cacheResponse, invalidateCacheOnSuccess } from '../middlewares/cache.middleware.js';
import multer from 'multer';
import path from 'path';

// Optional camera-proof upload (images only, 10 MB) — buffer goes to the shared
// S3/local store. Must run before the body-reading site-access middlewares so
// multipart fields are parsed into req.body.
const uploadProofPhoto = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const okExt = /\.(jpg|jpeg|png|webp)$/.test(path.extname(file.originalname).toLowerCase());
    const okMime = /^image\/(jpe?g|png|webp)$/.test(file.mimetype);
    if (okExt && okMime) return cb(null, true);
    cb(new Error('Proof must be a photo (jpg, png or webp)'));
  },
}).single('photo');

const imprestReadCache = cacheResponse({ ttlSeconds: 30, namespace: 'imprest' });
const bustImprestCache = invalidateCacheOnSuccess(['imprest|']);

const accessByQuerySite = requireImprestSiteAccess({ entity: 'site', source: 'query', key: 'site_id' });
const accessByRequiredQuerySite = requireImprestSiteAccess({ entity: 'site', source: 'query', key: 'site_id', required: true });
const accessByRequiredBodySite = requireImprestSiteAccess({ entity: 'site', source: 'body', key: 'site_id', required: true });
const accessByAllocation = requireImprestSiteAccess({ entity: 'allocation', source: 'params', key: 'id' });
const accessByExpenseRequest = requireImprestSiteAccess({ entity: 'expenseRequest', source: 'params', key: 'id' });
const accessByReturn = requireImprestSiteAccess({ entity: 'return', source: 'params', key: 'id' });
const requireAllocationRecipient = requireImprestParticipant({ key: 'sub_admin_id', label: 'Recipient' });
const requireTargetUser = requireImprestParticipant({ key: 'user_id', label: 'Target user' });
const requireTransferSource = requireImprestParticipant({ key: 'from_user_id', label: 'Source account', required: false });
const requireTransferRecipient = requireImprestParticipant({ key: 'to_user_id', label: 'Recipient' });
const requireAssignedReviewer = requireImprestParticipant({
  key: 'assigned_admin_id',
  label: 'Assigned reviewer',
  required: false,
});

// All imprest routes require auth
router.use(authMiddleware);

// ── Balance & Ledger (any authenticated user) ──
router.get('/balance', requirePermission('imprest', 'read'), accessByQuerySite, imprestReadCache, getBalance);
router.get('/site-balance', requirePermission('imprest', 'read'), accessByQuerySite, imprestReadCache, getSiteBalance);
router.get('/ledger', requirePermission('imprest', 'read'), accessByQuerySite, imprestReadCache, getLedger);
router.get('/peers', requirePermission('imprest', 'read'), accessByQuerySite, imprestReadCache, listTransferPeers);

// ── Immediate balance-to-balance transfers ──
router.get('/transfers', requirePermission('imprest', 'read'), accessByRequiredQuerySite, imprestReadCache, listTransfers);
router.post('/transfers', requirePermission('imprest', 'write'), accessByRequiredBodySite, requireTransferSource, requireTransferRecipient, bustImprestCache, createTransfer);

// ── Pending receipts (sub-admin confirms received funds) ──
router.get('/pending-receipts', requirePermission('imprest', 'read'), accessByQuerySite, imprestReadCache, getPendingReceipts);
// Confirming money physically received is an ownership action, not a module
// edit. The controller still verifies that the allocation belongs to caller.
router.put('/allocations/:id/confirm', requirePermission('imprest', 'read'), accessByAllocation, bustImprestCache, confirmReceipt);

// Declining mirrors confirming: it is the recipient's decision, so it rides on
// read permission — the recipient may hold neither write nor delete.
router.put('/allocations/:id/decline', requirePermission('imprest', 'read'), accessByAllocation, bustImprestCache, declineReceipt);

// ── Sub-admin creates expense from imprest ──
router.post('/expense', requirePermission('imprest', 'write'), uploadProofPhoto, accessByRequiredBodySite, requireAssignedReviewer, bustImprestCache, createExpenseFromImprest);

// ── Expense requests (overdraft flow) ──
router.get('/expense-requests', requirePermission('imprest', 'read'), accessByQuerySite, imprestReadCache, listExpenseRequests);
// A user who can open their Imprest account may ask for a refill even when
// their role is not allowed to post expenses or transfers.
router.post('/expense-requests', requirePermission('imprest', 'read'), accessByRequiredBodySite, requireAssignedReviewer, bustImprestCache, createExpenseRequest);

// ── Allocations: admin → sub-admin OR sub-admin → sub-admin (peer transfer) ──
// Controller enforces role-specific rules (ledger debit for sub-admin giver, ownership check on cancel).
router.post('/allocations', requirePermission('imprest', 'write'), uploadProofPhoto, accessByRequiredBodySite, requireAllocationRecipient, requireAssignedReviewer, bustImprestCache, createAllocation);
router.get('/allocations', requirePermission('imprest', 'read'), accessByQuerySite, imprestReadCache, listAllocations);
router.delete('/allocations/:id', requirePermission('imprest', 'delete'), accessByAllocation, bustImprestCache, cancelAllocation);

// ── Admin-only routes ──
router.get('/all-balances', requireRole('admin'), accessByQuerySite, imprestReadCache, getAllBalances);
router.post('/adjust', requireRole('admin'), uploadProofPhoto, accessByRequiredBodySite, requireTargetUser, bustImprestCache, adjustBalance);

// ── Assigned reviewer approve/reject expense requests ──
// Controllers limit sub-admins to requests explicitly assigned to them.
router.put('/expense-requests/:id/approve', requireRole('admin', 'sub_admin'), requirePermission('imprest', 'read'), accessByExpenseRequest, bustImprestCache, approveExpenseRequest);
router.put('/expense-requests/:id/reject', requireRole('admin', 'sub_admin'), requirePermission('imprest', 'read'), accessByExpenseRequest, bustImprestCache, rejectExpenseRequest);

// ── Imprest returns (sub-admin → admin money return) ──
router.post('/returns', requirePermission('imprest', 'write'), uploadProofPhoto, accessByRequiredBodySite, requireAssignedReviewer, bustImprestCache, createReturn);
router.get('/returns', requirePermission('imprest', 'read'), accessByQuerySite, imprestReadCache, listReturns);
router.get('/pending-returns', requireRole('admin'), accessByQuerySite, imprestReadCache, getPendingReturns);
router.put('/returns/:id/accept', requireRole('admin'), accessByReturn, bustImprestCache, acceptReturn);
router.put('/returns/:id/reject', requireRole('admin'), accessByReturn, bustImprestCache, rejectReturn);

export default router;
