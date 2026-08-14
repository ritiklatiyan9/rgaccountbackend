import express from 'express';
import authMiddleware from '../middlewares/auth.middleware.js';
import requireRole from '../middlewares/role.middleware.js';
import { attachOrgContext } from '../utils/complianceAccess.js';
import {
  getConnectUrl,
  oauthCallback,
  disconnect,
  getStatus,
  setNotifyAttendees,
  syncFutureEvents,
  addNotifyEmail,
  removeNotifyEmail,
} from '../controllers/googleCalendar.controller.js';

const router = express.Router();

// Google's browser redirect carries no auth header; the HMAC-signed state
// param (minted by the authenticated /connect call) authenticates this hit.
router.get('/google-calendar/callback', oauthCallback);

// Any authenticated user may see whether calendar sync is on; only admins
// may connect, disconnect, or edit the attendee list — same split as the
// other /settings routes (read open, writes admin-only).
router.get('/google-calendar/status', authMiddleware, attachOrgContext, getStatus);
router.get('/google-calendar/connect', authMiddleware, attachOrgContext, requireRole('admin'), getConnectUrl);
router.post('/google-calendar/disconnect', authMiddleware, attachOrgContext, requireRole('admin'), disconnect);
router.post('/google-calendar/sync', authMiddleware, attachOrgContext, requireRole('admin'), syncFutureEvents);
router.post('/google-calendar/notifications', authMiddleware, attachOrgContext, requireRole('admin'), setNotifyAttendees);
router.post('/google-calendar/emails', authMiddleware, attachOrgContext, requireRole('admin'), addNotifyEmail);
router.delete('/google-calendar/emails/:id', authMiddleware, attachOrgContext, requireRole('admin'), removeNotifyEmail);

export default router;
