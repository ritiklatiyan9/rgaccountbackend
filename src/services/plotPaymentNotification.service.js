import pool from '../config/db.js';
import applicationSettingModel from '../models/ApplicationSetting.model.js';
import { normalisePhone, notifyPlotPaymentRecorded } from '../utils/notify.js';
import { enqueueSms, isSmsQueueConfigured } from '../utils/sqs.js';
import { allocateInstallmentPayments } from './installmentAllocation.service.js';

export const PAYMENT_NOTIFICATION_SETTING_KEY = 'plot_payment_notifications';

export const PAYMENT_NOTIFICATION_MODES = Object.freeze([
  'CASH', 'BANK', 'CHEQUE', 'UPI', 'NEFT', 'RTGS', 'IMPS', 'TRANSFER',
  'BOOKING', 'ADJUST', 'RETURN', 'REFUND', 'OTHER',
]);

export const PAYMENT_NOTIFICATION_PLACEHOLDERS = Object.freeze([
  'customer_name', 'buyer_name', 'plot_no', 'block', 'installment_name',
  'amount', 'mode', 'payment_date', 'receipt_no', 'total_received',
  'balance_due', 'site_name',
]);

export const DEFAULT_PAYMENT_NOTIFICATION_MESSAGE =
  'Dear {{customer_name}}, we received Rs.{{amount}} via {{mode}} for Plot {{plot_no}} ({{installment_name}}) on {{payment_date}}. Balance: Rs.{{balance_due}}. - {{site_name}}';

const MAX_MESSAGE_LENGTH = 500;
const allowedPlaceholders = new Set(PAYMENT_NOTIFICATION_PLACEHOLDERS);

const configError = (message) => {
  const error = new Error(message);
  error.statusCode = 400;
  error.code = 'INVALID_PAYMENT_NOTIFICATION_CONFIG';
  return error;
};

const messageFor = (value) => {
  const message = typeof value === 'string' ? value.trim() : '';
  return message || DEFAULT_PAYMENT_NOTIFICATION_MESSAGE;
};

const assertValidMessage = (message, mode) => {
  if (message.length > MAX_MESSAGE_LENGTH) {
    throw configError(`${mode} notification message must be ${MAX_MESSAGE_LENGTH} characters or fewer`);
  }
  const unknown = [...message.matchAll(/{{\s*([a-z_]+)\s*}}/gi)]
    .map((match) => match[1].toLowerCase())
    .filter((key) => !allowedPlaceholders.has(key));
  if (unknown.length) {
    throw configError(`Unknown placeholder in ${mode} message: {{${unknown[0]}}}`);
  }
};

export const normalisePaymentNotificationMode = (value) => {
  const mode = String(value || '').trim().toUpperCase();
  if (mode === 'BANK TRANSFER' || mode === 'ACCOUNT TRANSFER') return 'TRANSFER';
  if (mode === 'CHECK') return 'CHEQUE';
  return PAYMENT_NOTIFICATION_MODES.includes(mode) ? mode : 'OTHER';
};

export const normalisePaymentNotificationConfig = (raw, { validate = false } = {}) => {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const sourceModes = source.modes && typeof source.modes === 'object' && !Array.isArray(source.modes)
    ? source.modes
    : {};
  const modes = {};

  for (const mode of PAYMENT_NOTIFICATION_MODES) {
    const posted = sourceModes[mode] ?? sourceModes[mode.toLowerCase()];
    const row = posted && typeof posted === 'object' && !Array.isArray(posted)
      ? posted
      : {};
    const message = messageFor(row.message);
    if (validate) assertValidMessage(message, mode);
    modes[mode] = {
      enabled: typeof posted === 'boolean'
        ? posted
        : row.enabled === undefined
          ? true
          : Boolean(row.enabled),
      message,
    };
  }

  return { enabled: Boolean(source.enabled), modes };
};

export const getPaymentNotificationConfig = async (siteId) =>
  normalisePaymentNotificationConfig(
    await applicationSettingModel.getJson(siteId, PAYMENT_NOTIFICATION_SETTING_KEY, null)
  );

export const savePaymentNotificationConfig = async (siteId, raw, userId) => {
  const config = normalisePaymentNotificationConfig(raw, { validate: true });
  await applicationSettingModel.setJson(siteId, PAYMENT_NOTIFICATION_SETTING_KEY, config, userId);
  return config;
};

const amountText = (value) => Number(value || 0).toLocaleString('en-IN', {
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});

const dateText = (value) => {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleDateString('en-IN', {
    day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'Asia/Kolkata',
  });
};

export const renderPaymentNotification = (template, values = {}) =>
  messageFor(template).replace(/{{\s*([a-z_]+)\s*}}/gi, (_match, key) => {
    const normalizedKey = String(key).toLowerCase();
    return values[normalizedKey] === undefined || values[normalizedKey] === null
      ? ''
      : String(values[normalizedKey]);
  });

const loadNotificationContext = async (payment) => {
  const { rows: plotRows } = await pool.query(
    `SELECT p.id, p.plot_no, p.block, p.buyer_name, p.site_id, p.sale_price,
            p.installments_enabled, s.name AS site_name,
            member.whatsapp, member.phone, member.alt_phone
       FROM plots p
       JOIN sites s ON s.id = p.site_id
       LEFT JOIN LATERAL (
         SELECT m.whatsapp, m.phone, m.alt_phone
           FROM members m
          WHERE m.site_id = p.site_id
            AND UPPER(TRIM(m.full_name)) = UPPER(TRIM(p.buyer_name))
          ORDER BY m.id
          LIMIT 1
       ) member ON TRUE
      WHERE p.id = $1
      LIMIT 1`,
    [payment.plot_id]
  );
  const plot = plotRows[0];
  if (!plot) return null;

  const { rows: installments } = await pool.query(
    `SELECT id, installment_name, amount, due_date, sort_order
       FROM plot_installments
      WHERE plot_id = $1
      ORDER BY sort_order, due_date, id`,
    [plot.id]
  );
  if (!plot.installments_enabled && installments.length === 0) {
    return { plot, installments, installmentPlan: false };
  }

  const [{ rows: genericRows }, { rows: directRows }] = await Promise.all([
    pool.query(
      `SELECT COALESCE(SUM(amount), 0)::numeric AS total
         FROM plot_payments
        WHERE plot_id = $1
          AND financial_transaction_posts('credit', status, payment_type, cheque_status)`,
      [plot.id]
    ),
    pool.query(
      `SELECT installment_id, COALESCE(SUM(amount), 0)::numeric AS total
         FROM plot_installment_payments
        WHERE plot_id = $1
          AND financial_transaction_posts('credit', status, payment_mode, cheque_status)
        GROUP BY installment_id`,
      [plot.id]
    ),
  ]);

  const genericPaid = Number.parseFloat(genericRows[0]?.total) || 0;
  const directPaidByInstallment = Object.fromEntries(
    directRows.map((row) => [row.installment_id, Number.parseFloat(row.total) || 0])
  );
  const currentAmount = Math.max(Number.parseFloat(payment.amount) || 0, 0);
  const before = allocateInstallmentPayments(installments, {
    genericPaid: Math.max(genericPaid - currentAmount, 0), directPaidByInstallment,
  }).installments;
  const afterState = allocateInstallmentPayments(installments, {
    genericPaid, directPaidByInstallment,
  });
  const affectedNames = afterState.installments
    .filter((row, index) => row.paid > (before[index]?.paid || 0))
    .map((row) => row.installment_name)
    .filter(Boolean);
  const nextUnpaid = afterState.installments.find((row) => row.remaining > 0);

  return {
    plot,
    installments,
    installmentPlan: true,
    genericPaid,
    directTotal: directRows.reduce((sum, row) => sum + (Number.parseFloat(row.total) || 0), 0),
    affectedInstallment: affectedNames.join(', ') || nextUnpaid?.installment_name || 'Installment plan',
  };
};

/**
 * Approval-time dispatcher. Installment-plan plots obey the Settings switches
 * and use custom SMS copy; plots without a plan retain the existing WhatsApp
 * receipt behavior unchanged.
 */
export const notifyApprovedPlotPayment = async (payment) => {
  try {
    if (!payment?.plot_id) return { queued: false, reason: 'missing_plot' };
    const context = await loadNotificationContext(payment);
    if (!context?.plot) return { queued: false, reason: 'plot_not_found' };
    if (!context.installmentPlan) {
      await notifyPlotPaymentRecorded(payment);
      return { queued: false, legacy: true };
    }

    const config = await getPaymentNotificationConfig(context.plot.site_id);
    const mode = normalisePaymentNotificationMode(payment.payment_from || payment.payment_type);
    const modeConfig = config.modes[mode];
    if (!config.enabled) return { queued: false, reason: 'disabled' };
    if (!modeConfig?.enabled) return { queued: false, reason: 'mode_disabled', mode };
    if ((Number.parseFloat(payment.amount) || 0) <= 0) {
      return { queued: false, reason: 'not_a_receipt', mode };
    }
    if (!isSmsQueueConfigured()) return { queued: false, reason: 'queue_not_configured', mode };

    const phone = normalisePhone(
      context.plot.whatsapp || context.plot.phone || context.plot.alt_phone
    );
    if (!phone) return { queued: false, reason: 'missing_phone', mode };

    const totalReceived = context.genericPaid + context.directTotal;
    const balanceDue = Math.max((Number.parseFloat(context.plot.sale_price) || 0) - totalReceived, 0);
    const message = renderPaymentNotification(modeConfig.message, {
      customer_name: context.plot.buyer_name || 'Customer',
      buyer_name: context.plot.buyer_name || 'Customer',
      plot_no: context.plot.plot_no || '',
      block: context.plot.block || '',
      installment_name: context.affectedInstallment,
      amount: amountText(payment.amount),
      mode,
      payment_date: dateText(payment.date),
      receipt_no: payment.id ? `RG-${payment.id}` : '',
      total_received: amountText(totalReceived),
      balance_due: amountText(balanceDue),
      site_name: context.plot.site_name || 'Defence Garden',
    });
    const dedupeKey = `payment-received:${payment.id}`;
    const { rows } = await pool.query(
      `INSERT INTO sms_reminder_log
         (site_id, plot_id, dedupe_key, phone, reminder_type, message, source, queued_by)
       VALUES ($1,$2,$3,$4,'payment_received',$5,'receipt',$6)
       ON CONFLICT (site_id, dedupe_key) DO NOTHING
       RETURNING id`,
      [context.plot.site_id, context.plot.id, dedupeKey, phone, message, payment.approved_by || null]
    );
    if (!rows[0]) return { queued: false, reason: 'duplicate', mode };

    const logId = rows[0].id;
    const result = await enqueueSms([{
      log_id: logId,
      site_id: context.plot.site_id,
      plot_id: context.plot.id,
      payment_id: payment.id,
      to: phone,
      message,
    }]);
    if (result.queued === 1) return { queued: true, log_id: logId, mode };

    const error = result.failed[0]?.error || 'Could not queue SMS';
    await pool.query(
      'UPDATE sms_reminder_log SET status = $1, error = $2 WHERE id = $3',
      ['failed', String(error).slice(0, 500), logId]
    );
    return { queued: false, reason: 'queue_failed', mode, error };
  } catch (error) {
    console.error('[payment-notifications] dispatch failed:', error?.message || error);
    return { queued: false, reason: 'error', error: error?.message || String(error) };
  }
};
