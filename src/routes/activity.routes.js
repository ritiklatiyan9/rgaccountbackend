import express from 'express';
import { getTodayActivity } from '../controllers/activity.controller.js';
import authMiddleware from '../middlewares/auth.middleware.js';
import requireRole from '../middlewares/role.middleware.js';

const router = express.Router();

// Only admin needs to see all activity metrics
router.get('/today', authMiddleware, requireRole('admin'), getTodayActivity);

export default router;
