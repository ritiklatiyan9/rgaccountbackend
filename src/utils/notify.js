import { accountWhatsAppHooks } from '../services/accountWhatsAppHooks.service.js';

// MSG91 WhatsApp Business API (v5) — bulk template endpoint.
// Mirrors the proven Make-Andaman-Trip setup (whatsappService.js +
// bookingNotifier.js): same payload shape, en_US, namespace, a generic
// `sendWATemplate`, and a `msg` builder layer that reuses already-approved
// templates so nothing needs fresh Meta approval.
const MSG91_API_URL = 'https://api.msg91.com/api/v5/whatsapp/whatsapp-outbound-message/bulk/';

const SENDER_ID = () => process.env.MSG91_SENDER_ID || '919474261969';
const NAMESPACE = () => process.env.MSG91_WHATSAPP_NAMESPACE || '5452dda1_1477_44cd_bab3_dd09fef861d2';
const LANG = () => process.env.MSG91_WHATSAPP_LANG || 'en_US';
// Dedicated detailed plot-payment receipt template (8 body variables).
const PAYMENT_TEMPLATE = () => process.env.MSG91_WHATSAPP_TEMPLATE || 'plot_payment_receipt';

/** Best-effort: a missing auth key or any failure must never break the payment
 *  write. Once MSG91_AUTH_KEY is set, notifications are live. */
export function isWhatsAppConfigured() {
  return Boolean(process.env.MSG91_AUTH_KEY);
}

/** Normalise to MSG91's `<countrycode><number>` form (e.g. 919812345678). */
export function normalisePhone(raw) {
  if (!raw) return null;
  let d = String(raw).replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('0')) d = d.slice(1); // drop trunk 0
  if (d.length === 10) d = `91${d}`;                        // bare 10-digit → add 91
  if (d.length < 11 || d.length > 15) return null;
  return d;
}

const txt = (value) => ({ type: 'text', value });
const fmtAmt = (v) => `₹${(parseFloat(v) || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
const fmtDate = (d) => {
  if (!d) return '';
  const dt = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(dt.getTime())) return String(d);
  return dt.toLocaleDateString('en-IN', { day: '2-digit', month: '2-digit', year: 'numeric' });
};

// =============================
// MESSAGE BUILDERS (mirrors bookingNotifier.js `msg`)
// Each returns { template, components } for an approved MSG91 template.
// =============================
export const msg = {
  // Detailed receipt template `plot_payment_receipt` — 8 body variables, one
  // per detail (each value must be single-line; WhatsApp rejects newlines in
  // template variables):
  //   {{1}} owner  {{2}} plot  {{3}} receipt no  {{4}} amount
  //   {{5}} mode   {{6}} date  {{7}} total received  {{8}} balance due
  plotPaymentRecorded: (d) => ({
    template: PAYMENT_TEMPLATE(),
    components: {
      body_1: txt(d.ownerName),
      body_2: txt(d.plotLabel),
      body_3: txt(d.receiptNo),
      body_4: txt(fmtAmt(d.amount)),
      body_5: txt(d.mode),
      body_6: txt(fmtDate(d.date)),
      body_7: txt(fmtAmt(d.received)),
      body_8: txt(d.balance > 0 ? fmtAmt(d.balance) : '₹0 (Fully Paid)'),
    },
  }),
};

/**
 * Generic: send ONE approved WhatsApp template to ONE recipient.
 * `components` is the MSG91 body map, e.g. { body_1: { type:'text', value:'…' } }.
 * Returns { success, data|error } — never throws.
 */
export async function sendWATemplate(to, templateName, components = {}) {
  if (!process.env.MSG91_AUTH_KEY) {
    console.error('[notify] MSG91_AUTH_KEY not configured — skipping WhatsApp');
    return { success: false, error: 'not_configured' };
  }
  const normalized = normalisePhone(to);
  if (!normalized) {
    console.warn(`[notify] invalid/empty phone for WhatsApp: ${to}`);
    return { success: false, error: 'invalid_phone' };
  }

  // WhatsApp rejects template variables containing newlines/tabs — collapse them.
  const safeComponents = {};
  for (const [k, c] of Object.entries(components)) {
    safeComponents[k] = { ...c, value: String(c?.value ?? '').replace(/\s+/g, ' ').trim() };
  }

  const payload = {
    integrated_number: SENDER_ID(),
    content_type: 'template',
    payload: {
      messaging_product: 'whatsapp',
      type: 'template',
      template: {
        name: templateName,
        language: { code: LANG(), policy: 'deterministic' },
        namespace: NAMESPACE(),
        to_and_components: [{ to: [normalized], components: safeComponents }],
      },
    },
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(MSG91_API_URL, {
      method: 'POST',
      headers: { authkey: process.env.MSG91_AUTH_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error(`[notify] MSG91 HTTP ${res.status}:`, JSON.stringify(data));
      return { success: false, error: data?.message || `HTTP ${res.status}`, data };
    }
    console.log(`[notify] WhatsApp "${templateName}" sent to +${normalized}`);
    return { success: true, data };
  } catch (err) {
    console.error('[notify] MSG91 send failed:', err?.message || err);
    return { success: false, error: err?.message || String(err) };
  } finally {
    clearTimeout(timer);
  }
}

/** Backward-compatible entry point. Payment WhatsApp now always obeys the
 * Accountancy Studio assignment, approval and non-CASH policy. Generic MSG91
 * helpers above remain available for the separate compliance scheduler. */
export async function notifyPlotPaymentRecorded(payment) {
  return accountWhatsAppHooks.paymentApproved('plot_payment', payment);
}
