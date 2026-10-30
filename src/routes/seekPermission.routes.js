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
  getSeekPermission,
  getSeekComments,
  createSeekComment,
  markSeekCommentsSeen,
} from '../controllers/seekPermission.controller.js';

export function createSeekPermissionRouter({ authenticate = authMiddleware } = {}) {
const router = express.Router();

// Sub-admins ask; the person asked (or any admin) decides. The service re-checks
// role, organisation, site assignment and visibility on every call, so nothing
// here is cached.
router.use(authenticate, requireRole('admin', 'sub_admin'));

router.get('/', listSeekPermissions);
router.get('/inbox', getSeekInbox);
router.get('/people', getSeekTargets);
// Up to 5 PDFs/photos (already optimized in the browser), 5 MB each.
router.post('/', receiveUpload(upload.array('attachments', 5)), createSeekPermission);
router.post('/seen', markSeekSeen);
router.get('/access', requireRole('admin'), getSeekAccess);
router.put('/access/:userId', requireRole('admin'), updateSeekAccess);
router.get('/:id', getSeekPermission);
router.get('/:id/comments', getSeekComments);
router.post('/:id/comments', createSeekComment);
router.post('/:id/comments/seen', markSeekCommentsSeen);
router.get('/:id/attachments/:index', getSeekAttachment);
router.put('/:id/approve', decideSeekPermission('approve'));
router.put('/:id/reject', decideSeekPermission('reject'));
router.put('/:id/cancel', cancelSeekPermission);

return router;
}

export default createSeekPermissionRouter();
