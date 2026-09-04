import express from 'express';
import authMiddleware from '../middlewares/auth.middleware.js';
import requireRole from '../middlewares/role.middleware.js';
import requirePermission from '../middlewares/permission.middleware.js';
import { cacheResponse } from '../middlewares/cache.middleware.js';
import createRateLimiter from '../middlewares/rateLimit.middleware.js';
import {
  getOverview, getClients, getClientMap, getPaymentBehaviour,
  getRegistryAnalytics, getExpenseAnalytics, getVendorAnalytics, getConstructionAnalytics,
} from '../controllers/managementAnalytics.controller.js';
import { streamAssistant, generateInsights, chartInsight, runGeocode } from '../controllers/managementAnalyticsAi.controller.js';
import {
  createMessageCampaign, getMessagingOverview, listMessageCampaigns, listMessageRecipients,
} from '../controllers/managementAnalyticsMessaging.controller.js';

const router = express.Router();

// Whole-site aggregates: sub-admins are scoped by user_sites inside the controllers (not by created_by).
router.use(authMiddleware, requireRole('admin', 'sub_admin'), requirePermission('management_analytics', 'read'));

const cache = cacheResponse({ ttlSeconds: 120, namespace: 'management-analytics' });
const aiLimiter = createRateLimiter({ windowMs: 60_000, max: 24, keyPrefix: 'mgmt-ai:' });
const messagingLimiter = createRateLimiter({ windowMs: 60_000, max: 10, keyPrefix: 'mgmt-messaging:' });

router.get('/overview', cache, getOverview);
router.get('/clients', cache, getClients);
router.get('/clients/map', cache, getClientMap);
router.get('/payment-behaviour', cache, getPaymentBehaviour);
router.get('/registries', cache, getRegistryAnalytics);
router.get('/expenses', cache, getExpenseAnalytics);
router.get('/vendors', cache, getVendorAnalytics);
router.get('/construction', cache, getConstructionAnalytics);
router.get('/messaging/overview', requirePermission('client_messaging', 'read'), getMessagingOverview);
router.get('/messaging/recipients', requirePermission('client_messaging', 'read'), listMessageRecipients);
router.get('/messaging/campaigns', requirePermission('client_messaging', 'read'), listMessageCampaigns);
router.post(
  '/messaging/campaigns',
  requirePermission('client_messaging', 'write'),
  messagingLimiter,
  createMessageCampaign
);

router.post('/assistant', aiLimiter, streamAssistant);
router.post('/insights', aiLimiter, generateInsights);
router.post('/chart-insight', aiLimiter, chartInsight);
router.post('/geocode/run', requireRole('admin'), runGeocode);

export default router;
