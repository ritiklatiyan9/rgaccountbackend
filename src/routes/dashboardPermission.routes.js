import express from 'express';
const router = express.Router();
import {
  getDashboardPermissions,
  getMyDashboardPermissions,
  updateDashboardPermissions,
  listUsersWithDashboardPermissions,
} from '../controllers/dashboardPermission.controller.js';
import authMiddleware from '../middlewares/auth.middleware.js';
import requireRole from '../middlewares/role.middleware.js';

// Any logged-in user can fetch their own dashboard permissions
router.get('/me', authMiddleware, getMyDashboardPermissions);

// Admin-only: manage other users' dashboard component access
router.use(authMiddleware, requireRole('admin'));

router.get('/users', listUsersWithDashboardPermissions);
router.get('/:userId', getDashboardPermissions);
router.put('/:userId', updateDashboardPermissions);

export default router;
