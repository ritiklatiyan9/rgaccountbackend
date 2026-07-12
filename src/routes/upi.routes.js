import express from 'express';
const router = express.Router();

import {
  listAccounts, createAccount, updateAccount, deleteAccount,
  createQr, listQrs, updateQrStatus, getDisplayQr, updateQr, deleteQr,
} from '../controllers/upi.controller.js';
import authMiddleware from '../middlewares/auth.middleware.js';
import requireRole from '../middlewares/role.middleware.js';
import requirePermission from '../middlewares/permission.middleware.js';

router.use(authMiddleware);
router.use(requireRole('admin', 'sub_admin'));

// ── Bank accounts / VPAs ──
router.get('/accounts', requirePermission('upi_collect', 'read'), listAccounts);
router.post('/accounts', requirePermission('upi_collect', 'write'), createAccount);
router.put('/accounts/:id', requirePermission('upi_collect', 'update'), updateAccount);
router.delete('/accounts/:id', requirePermission('upi_collect', 'delete'), deleteAccount);

// ── Dynamic QR log ──
router.get('/qrs/display', requirePermission('upi_collect', 'read'), getDisplayQr);
router.get('/qrs', requirePermission('upi_collect', 'read'), listQrs);
router.post('/qrs', requirePermission('upi_collect', 'write'), createQr);
router.put('/qrs/:id/status', requirePermission('upi_collect', 'update'), updateQrStatus);
router.put('/qrs/:id', requirePermission('upi_collect', 'update'), updateQr);
router.delete('/qrs/:id', requirePermission('upi_collect', 'delete'), deleteQr);

export default router;
