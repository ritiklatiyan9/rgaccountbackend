import express from 'express';
import multer from 'multer';
import authMiddleware from '../middlewares/auth.middleware.js';
import requireRole from '../middlewares/role.middleware.js';
import requirePermission from '../middlewares/permission.middleware.js';
import { requireAllEntryVisibility } from '../middlewares/entryCreatorAccess.middleware.js';
import {
  applyBankDaybookReconciliation,
  previewBankDaybookReconciliation,
} from '../controllers/bankDaybookReconciliation.controller.js';
import { getActiveBankDaybookStatementView } from '../controllers/bankDaybookStatementView.controller.js';
import {
  confirmMatches,
  createUpload,
  getConfiguration,
  getRun,
  getUpload,
  listPendingCheques,
  matchUpload,
} from '../controllers/bankReconciliation.controller.js';
import {
  createTransactionUpload,
  getLatestTransactionUpload,
  getTransactionUpload,
  linkTransactionPosting,
} from '../controllers/transactionReconciliation.controller.js';

const router = express.Router();
const allowedExtensions = new Set(['.xlsx', '.xls', '.csv']);
const extensionOf = (filename) => String(filename || '').toLowerCase().match(/\.[^.]+$/)?.[0] || '';
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, callback) => {
    if (!allowedExtensions.has(extensionOf(file.originalname))) {
      const error = new Error('Only .xlsx, .xls, and .csv bank statements are supported.');
      error.statusCode = 415;
      error.code = 'UNSUPPORTED_FILE_TYPE';
      return callback(error);
    }
    return callback(null, true);
  },
});

router.use(authMiddleware);
router.use(requireRole('admin', 'sub_admin'));

// General Bank Day Book reconciliation is presentation-only and follows the
// Day Book permission model. Keep it separate from the cheque-clearing routes
// below, which intentionally remain under expense approval permissions.
router.post(
  '/daybook/preview',
  requirePermission('daybook', 'read'),
  requireAllEntryVisibility('daybook'),
  upload.single('statement'),
  previewBankDaybookReconciliation
);
router.post(
  '/daybook/apply',
  requirePermission('daybook', 'update'),
  requireAllEntryVisibility('daybook'),
  upload.single('statement'),
  applyBankDaybookReconciliation
);
// An imported statement can be used as a read-only Bank Day Book presentation
// without changing underlying accounting entries in any module.
router.get(
  '/daybook/statement-view',
  requirePermission('daybook', 'read'),
  requireAllEntryVisibility('daybook'),
  getActiveBankDaybookStatementView,
);

// General transaction reconciliation has its own workflow namespace and
// persists one verified module link per statement row. Target module writes
// are still authorised by each module's existing create endpoint.
router.get(
  '/transaction-uploads/latest',
  requirePermission('daybook', 'read'),
  getLatestTransactionUpload
);
router.get(
  '/transaction-uploads/:uploadId',
  requirePermission('daybook', 'read'),
  getTransactionUpload
);
router.post(
  '/transaction-uploads',
  requirePermission('daybook', 'write'),
  upload.single('statement'),
  createTransactionUpload
);
router.post(
  '/transaction-postings/:transactionId',
  requirePermission('daybook', 'write'),
  linkTransactionPosting
);

router.use(requirePermission('expense_approval', 'read'));

router.get('/configuration', getConfiguration);
router.get('/pending-cheques', listPendingCheques);
router.post('/uploads', upload.single('statement'), createUpload);
router.get('/uploads/:uploadId', getUpload);
router.post('/uploads/:uploadId/match', matchUpload);
router.get('/runs/:runId', getRun);
router.post('/uploads/:uploadId/confirm', requirePermission('expense_approval', 'update'), confirmMatches);

export default router;
