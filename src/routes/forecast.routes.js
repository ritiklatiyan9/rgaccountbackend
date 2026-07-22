import express from 'express';
import { getCashflowForecast } from '../controllers/forecast.controller.js';
import { streamForecastAssistant } from '../controllers/forecastAssistant.controller.js';
import authMiddleware from '../middlewares/auth.middleware.js';
import requirePermission from '../middlewares/permission.middleware.js';
import requireRole from '../middlewares/role.middleware.js';

const router = express.Router();
router.use(authMiddleware);

router.get(
  '/',
  requireRole('admin', 'sub_admin'),
  requirePermission('finance_forecast', 'read'),
  getCashflowForecast
);

router.post(
  '/assistant',
  requireRole('admin', 'sub_admin'),
  requirePermission('finance_forecast', 'read'),
  streamForecastAssistant,
);

export default router;
