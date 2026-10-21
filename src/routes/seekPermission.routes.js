import express from 'express';
import authMiddleware from '../middlewares/auth.middleware.js';
import requireRole from '../middlewares/role.middleware.js';
import {
  listSeekPermissions,
  getSeekInbox,
  createSeekPermission,
  decideSeekPermission,
  cancelSeekPermission,
  markSeekSeen,
  getSeekAccess,
  updateSeekAccess,
} from '../controllers/seekPermission.controller.js';

const router = express.Router();

// Sub-admins ask, admins decide. The service re-checks role, organisation, site
// assignment and Studio visibility on every call, so nothing here is cached.
router.use(authMiddleware, requireRole('admin', 'sub_admin'));

router.get('/', listSeekPermissions);
router.get('/inbox', getSeekInbox);
router.post('/', createSeekPermission);
router.post('/seen', markSeekSeen);
router.get('/access', requireRole('admin'), getSeekAccess);
router.put('/access/:userId', requireRole('admin'), updateSeekAccess);
router.put('/:id/approve', requireRole('admin'), decideSeekPermission('approve'));
router.put('/:id/reject', requireRole('admin'), decideSeekPermission('reject'));
router.put('/:id/cancel', cancelSeekPermission);

export default router;
