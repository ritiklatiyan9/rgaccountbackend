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
  getReceiptDesign,
  updateReceiptDesign,
  updateFeature,
  getPaymentNotificationSettings,
  updatePaymentNotificationSettings,
} from '../controllers/applicationSetting.controller.js';
import { invalidateCacheOnSuccess } from '../middlewares/cache.middleware.js';

const router = express.Router();
const bustRegistryCache = invalidateCacheOnSuccess(['registries|']);

// Every authenticated user may read flags for an assigned site because feature
// consumers (such as Plot Registry) need them. Only admins may change them.
router.get('/features', authMiddleware, getFeatures);
// One endpoint for every control-panel switch (validated against FEATURE_KEYS).
router.put('/features', authMiddleware, requireRole('admin'), bustRegistryCache, updateFeature);

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

// Approval-time receipt notifications for installment-plan plots — admin only,
// per site, with independent switches and copy for each payment mode.
router.get('/payment-notifications', authMiddleware, requireRole('admin'), getPaymentNotificationSettings);
router.put('/payment-notifications', authMiddleware, requireRole('admin'), updatePaymentNotificationSettings);

// Receipt rendering is shared by every transaction module, so every assigned
// user can read the active site design. Organisation-level edits remain admin-only.
router.get('/receipt-design', authMiddleware, getReceiptDesign);
router.put('/receipt-design', authMiddleware, requireRole('admin'), updateReceiptDesign);

export default router;
