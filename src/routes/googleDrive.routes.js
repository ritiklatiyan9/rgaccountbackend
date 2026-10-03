import express from 'express';
import authMiddleware from '../middlewares/auth.middleware.js';
import requireRole from '../middlewares/role.middleware.js';
import { attachOrgContext } from '../utils/complianceAccess.js';
import {
  getStatus,
  getConnectUrl,
  disconnect,
  listAccessEmails,
  addAccessEmail,
  updateAccessEmail,
  removeAccessEmail,
  listRecentShares,
} from '../controllers/googleDrive.controller.js';

const router = express.Router();

// The OAuth callback is shared with Google Calendar (same client + redirect
// URI): /settings/google-calendar/callback dispatches on the signed state's
// kind, so no Drive-specific callback route exists.

// Any authenticated user may see whether Drive is connected (the share dialog
// needs it); connecting, the access list and the share log are admin-only.
router.get('/google-drive/status', authMiddleware, attachOrgContext, getStatus);
router.get('/google-drive/connect', authMiddleware, attachOrgContext, requireRole('admin'), getConnectUrl);
router.post('/google-drive/disconnect', authMiddleware, attachOrgContext, requireRole('admin'), disconnect);
router.get('/google-drive/emails', authMiddleware, attachOrgContext, requireRole('admin'), listAccessEmails);
router.post('/google-drive/emails', authMiddleware, attachOrgContext, requireRole('admin'), addAccessEmail);
router.patch('/google-drive/emails/:id', authMiddleware, attachOrgContext, requireRole('admin'), updateAccessEmail);
router.delete('/google-drive/emails/:id', authMiddleware, attachOrgContext, requireRole('admin'), removeAccessEmail);
router.get('/google-drive/shares', authMiddleware, attachOrgContext, requireRole('admin'), listRecentShares);

export default router;
