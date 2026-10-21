import express from 'express';
import authMiddleware from '../middlewares/auth.middleware.js';
import requireRole from '../middlewares/role.middleware.js';
import upload, { receiveUpload } from '../middlewares/multer.middleware.js';
import {
  listSeekPermissions,
  getSeekInbox,
  getSeekTargets,
  createSeekPermission,
  getSeekAttachment,
  decideSeekPermission,
  cancelSeekPermission,
  markSeekSeen,
  getSeekAccess,
  updateSeekAccess,
} from '../controllers/seekPermission.controller.js';

const router = express.Router();

// Sub-admins ask; the person asked (or any admin) decides. The service re-checks
// role, organisation, site assignment and visibility on every call, so nothing
// here is cached.
router.use(authMiddleware, requireRole('admin', 'sub_admin'));

router.get('/', listSeekPermissions);
router.get('/inbox', getSeekInbox);
router.get('/people', getSeekTargets);
// Up to 5 PDFs/photos (already optimized in the browser), 5 MB each.
router.post('/', receiveUpload(upload.array('attachments', 5)), createSeekPermission);
router.post('/seen', markSeekSeen);
router.get('/access', requireRole('admin'), getSeekAccess);
router.put('/access/:userId', requireRole('admin'), updateSeekAccess);
router.get('/:id/attachments/:index', getSeekAttachment);
router.put('/:id/approve', decideSeekPermission('approve'));
router.put('/:id/reject', decideSeekPermission('reject'));
router.put('/:id/cancel', cancelSeekPermission);

export default router;
