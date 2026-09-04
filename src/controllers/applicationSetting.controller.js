import asyncHandler from '../utils/asyncHandler.js';
import pool from '../config/db.js';
import applicationSettingModel, { FEATURE_KEYS } from '../models/ApplicationSetting.model.js';
import { getConfig as getSmsConfig, saveConfig as saveSmsConfig } from '../services/smsReminder.service.js';
import { isSmsQueueConfigured } from '../utils/sqs.js';
import {
  getPaymentNotificationConfig,
  savePaymentNotificationConfig,
  PAYMENT_NOTIFICATION_MODES,
  PAYMENT_NOTIFICATION_PLACEHOLDERS,
} from '../services/plotPaymentNotification.service.js';
import {
  getReceiptDesign as readReceiptDesign,
  saveReceiptDesign,
  RECEIPT_TEMPLATE_IDS,
  RECEIPT_FIELD_KEYS,
} from '../services/receiptDesign.service.js';

const getAccessibleSiteId = async (req, res, rawSiteId) => {
  const siteId = Number.parseInt(rawSiteId, 10);
  if (!Number.isInteger(siteId) || siteId <= 0) {
    res.status(400).json({ message: 'A valid site_id is required' });
    return null;
  }

  const { rows } = await pool.query('SELECT id FROM sites WHERE id = $1 LIMIT 1', [siteId]);
  if (!rows[0]) {
    res.status(404).json({ message: 'Site not found' });
    return null;
  }

  if (req.user.role !== 'admin' && req.user.role !== 'super_admin') {
    const access = await pool.query(
      'SELECT 1 FROM user_sites WHERE user_id = $1 AND site_id = $2 LIMIT 1',
      [req.user.id, siteId]
    );
    if (!access.rows[0]) {
      res.status(403).json({ message: 'Access denied to this site' });
      return null;
    }
  }

  return siteId;
};

/** GET /settings/features?site_id=123 */
export const getFeatures = asyncHandler(async (req, res) => {
  const siteId = await getAccessibleSiteId(req, res, req.query.site_id);
  if (!siteId) return;

  const features = await applicationSettingModel.getFeatures(siteId);
  res.json({ site_id: siteId, features });
});

/** PUT /settings/features/plot-registry-workflow-unlocked */
export const updatePlotRegistryWorkflow = asyncHandler(async (req, res) => {
  const siteId = await getAccessibleSiteId(req, res, req.body.site_id);
  if (!siteId) return;

  if (typeof req.body.enabled !== 'boolean') {
    return res.status(400).json({ message: 'enabled must be a boolean' });
  }

  const enabled = await applicationSettingModel.setFeature(
    siteId,
    FEATURE_KEYS.PLOT_REGISTRY_WORKFLOW_UNLOCKED,
    req.body.enabled,
    req.user.id
  );

  res.json({
    site_id: siteId,
    features: { [FEATURE_KEYS.PLOT_REGISTRY_WORKFLOW_UNLOCKED]: enabled },
    message: enabled
      ? 'Plot Registry flexible navigation enabled'
      : 'Plot Registry sequential workflow restored',
  });
});

/**
 * PUT /settings/features
 * Body: { site_id, key, enabled } — one endpoint for every control-panel switch.
 */
const FEATURE_MESSAGES = {
  [FEATURE_KEYS.PLOT_REGISTRY_WORKFLOW_UNLOCKED]: {
    on: 'Plot Registry flexible navigation enabled',
    off: 'Plot Registry sequential workflow restored',
  },
  [FEATURE_KEYS.NOC_KYC_REQUIRED]: {
    on: 'KYC is required before a NOC can be generated',
    off: 'NOCs can now be generated without KYC — every issue is still recorded',
  },
};

export const updateFeature = asyncHandler(async (req, res) => {
  const siteId = await getAccessibleSiteId(req, res, req.body.site_id);
  if (!siteId) return;

  const key = String(req.body.key || '').trim();
  if (!Object.values(FEATURE_KEYS).includes(key)) {
    return res.status(400).json({ message: `Unknown setting: ${key || '(missing)'}` });
  }
  if (typeof req.body.enabled !== 'boolean') {
    return res.status(400).json({ message: 'enabled must be a boolean' });
  }

  const enabled = await applicationSettingModel.setFeature(siteId, key, req.body.enabled, req.user.id);
  const copy = FEATURE_MESSAGES[key];
  res.json({
    site_id: siteId,
    features: await applicationSettingModel.getFeatures(siteId),
    message: copy ? (enabled ? copy.on : copy.off) : 'Setting updated',
  });
});

const SIDEBAR_ORDER_KEY = 'sidebar_order';

/**
 * GET /settings/sidebar-order
 * The shared navigation order every user sees. Readable by anyone signed in;
 * `order: null` means "nobody has set an order — use the app default".
 */
export const getSidebarOrder = asyncHandler(async (req, res) => {
  const stored = await applicationSettingModel.getGlobalJson(SIDEBAR_ORDER_KEY, null);
  res.json({ order: Array.isArray(stored) ? stored : null });
});

/**
 * PUT /settings/sidebar-order  Body: { order: string[] }
 * Any signed-in user — sets the sidebar order for every user in the org.
 * Last write wins; `updated_by` keeps it attributable.
 */
export const updateSidebarOrder = asyncHandler(async (req, res) => {
  const { order } = req.body;
  if (!Array.isArray(order) || !order.length) {
    return res.status(400).json({ message: 'order must be a non-empty array of sidebar ids' });
  }
  if (!order.every((id) => typeof id === 'string' && id.trim() && id.length <= 64)) {
    return res.status(400).json({ message: 'order must contain only non-empty id strings' });
  }
  if (new Set(order).size !== order.length) {
    return res.status(400).json({ message: 'order must not contain duplicate ids' });
  }

  const saved = await applicationSettingModel.setGlobalJson(SIDEBAR_ORDER_KEY, order, req.user.id);
  res.json({ order: saved, message: 'Sidebar order saved for all users' });
});

/** GET /settings/sms-reminders?site_id=123 */
export const getSmsReminderSettings = asyncHandler(async (req, res) => {
  const siteId = await getAccessibleSiteId(req, res, req.query.site_id);
  if (!siteId) return;

  res.json({
    site_id: siteId,
    settings: await getSmsConfig(siteId),
    queue_configured: isSmsQueueConfigured(),
  });
});

/** PUT /settings/sms-reminders */
export const updateSmsReminderSettings = asyncHandler(async (req, res) => {
  const siteId = await getAccessibleSiteId(req, res, req.body.site_id);
  if (!siteId) return;

  const settings = await saveSmsConfig(siteId, req.body, req.user.id);
  res.json({
    site_id: siteId,
    settings,
    queue_configured: isSmsQueueConfigured(),
    message: settings.enabled
      ? `Automatic SMS reminders on — ${settings.days_before.join(', ')} day(s) around the due date at ${String(settings.send_hour).padStart(2, '0')}:00 IST`
      : 'Automatic SMS reminders turned off',
  });
});

/** GET /settings/payment-notifications?site_id=123 */
export const getPaymentNotificationSettings = asyncHandler(async (req, res) => {
  const siteId = await getAccessibleSiteId(req, res, req.query.site_id);
  if (!siteId) return;

  res.json({
    site_id: siteId,
    settings: await getPaymentNotificationConfig(siteId),
    mode_keys: PAYMENT_NOTIFICATION_MODES,
    placeholders: PAYMENT_NOTIFICATION_PLACEHOLDERS,
    queue_configured: isSmsQueueConfigured(),
  });
});

/** PUT /settings/payment-notifications */
export const updatePaymentNotificationSettings = asyncHandler(async (req, res) => {
  const siteId = await getAccessibleSiteId(req, res, req.body.site_id);
  if (!siteId) return;

  const settings = await savePaymentNotificationConfig(siteId, req.body, req.user.id);
  res.json({
    site_id: siteId,
    settings,
    mode_keys: PAYMENT_NOTIFICATION_MODES,
    placeholders: PAYMENT_NOTIFICATION_PLACEHOLDERS,
    queue_configured: isSmsQueueConfigured(),
    message: settings.enabled
      ? 'Installment payment notifications enabled for this site'
      : 'Installment payment notifications turned off',
  });
});

/** GET /settings/receipt-design?site_id=123 */
export const getReceiptDesign = asyncHandler(async (req, res) => {
  const siteId = await getAccessibleSiteId(req, res, req.query.site_id);
  if (!siteId) return;

  res.json({
    site_id: siteId,
    design: await readReceiptDesign(siteId),
    template_ids: RECEIPT_TEMPLATE_IDS,
    field_keys: RECEIPT_FIELD_KEYS,
  });
});

/** PUT /settings/receipt-design  Body: { site_id, design } */
export const updateReceiptDesign = asyncHandler(async (req, res) => {
  const siteId = await getAccessibleSiteId(req, res, req.body.site_id);
  if (!siteId) return;

  if (!req.body.design || typeof req.body.design !== 'object' || Array.isArray(req.body.design)) {
    return res.status(400).json({ message: 'design must be an object' });
  }

  const design = await saveReceiptDesign(siteId, req.body.design, req.user.id);
  res.json({ site_id: siteId, design, message: 'Receipt designs saved for this site' });
});
