import express from 'express';
import authMiddleware from '../middlewares/auth.middleware.js';
import requireRole from '../middlewares/role.middleware.js';
import {
  getFeatures,
  updatePlotRegistryWorkflow,
  getSidebarOrder,
  updateSidebarOrder,
  getSmsReminderSettings,
  updateSmsReminderSettings,
} from '../controllers/applicationSetting.controller.js';
import { invalidateCacheOnSuccess } from '../middlewares/cache.middleware.js';

const router = express.Router();
const bustRegistryCache = invalidateCacheOnSuccess(['registries|']);

// Every authenticated user may read flags for an assigned site because feature
// consumers (such as Plot Registry) need them. Only admins may change them.
router.get('/features', authMiddleware, getFeatures);
router.put(
  '/features/plot-registry-workflow-unlocked',
  authMiddleware,
  requireRole('admin'),
  bustRegistryCache,
  updatePlotRegistryWorkflow
);

// Sidebar order is one shared navigation: every signed-in user both reads AND
// writes it, and a write applies to the whole organisation. Deliberately not
// role-gated — the team wanted anyone to be able to tidy the nav for everyone.
// The payload is still strictly validated in the controller, and
// application_settings records updated_by so a change is always attributable.
router.get('/sidebar-order', authMiddleware, getSidebarOrder);
router.put('/sidebar-order', authMiddleware, updateSidebarOrder);

// Payment-reminder SMS config — admin only, per site.
router.get('/sms-reminders', authMiddleware, requireRole('admin'), getSmsReminderSettings);
router.put('/sms-reminders', authMiddleware, requireRole('admin'), updateSmsReminderSettings);

export default router;
