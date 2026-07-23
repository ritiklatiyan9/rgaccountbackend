import express from 'express';
import { streamDashboardAssistant } from '../controllers/dashboardAssistant.controller.js';
import authMiddleware from '../middlewares/auth.middleware.js';
import requirePermission from '../middlewares/permission.middleware.js';
import requireRole from '../middlewares/role.middleware.js';

const router = express.Router();

router.use(
  authMiddleware,
  requireRole('admin', 'sub_admin'),
  requirePermission('dashboard', 'read'),
);
router.post('/assistant', streamDashboardAssistant);

export default router;

