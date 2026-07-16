import express from 'express';
import { getCashflowForecast } from '../controllers/forecast.controller.js';
import authMiddleware from '../middlewares/auth.middleware.js';
import requireRole from '../middlewares/role.middleware.js';

const router = express.Router();
router.use(authMiddleware);

// Dashboard-read pattern: role gate only (matches daybook analytics endpoints); data is site-scoped.
router.get('/', requireRole('admin', 'sub_admin'), getCashflowForecast);

export default router;
