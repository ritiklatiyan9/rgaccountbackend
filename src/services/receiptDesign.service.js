import { normalizeCanvasElements } from './receiptCanvas.schema.js';
import pool from '../config/db.js';
import applicationSettingModel from '../models/ApplicationSetting.model.js';

export const RECEIPT_DESIGN_KEY = 'receipt_design_v1';

export const RECEIPT_TEMPLATE_IDS = Object.freeze([
  'cash-plain-note', 'cash-plain-slip', 'cash-plain-letter',
  'cash-simple', 'cash-lined', 'cash-compact',
  'executive-classic', 'emerald-ledger', 'midnight-corporate', 'royal-indigo',
  'sandstone-legal', 'ocean-blue', 'minimal-mono', 'maroon-deed',
  'teal-modern', 'copper-vintage', 'graphite-grid', 'forest-bond',
  'azure-stripe', 'plum-elegance', 'saffron-ledger', 'slate-sidebar',
  'ruby-banner', 'clean-borderless', 'navy-watermark', 'compact-dual',
  'simple-office', 'simple-green', 'fine-line', 'receipt-book',
  'crafted-heritage', 'artisan-copper', 'sage-letterpress', 'royal-certificate',
]);

export const RECEIPT_FIELD_KEYS = Object.freeze([
  'cheque_notice', 'title', 'amount', 'copy_label', 'organization', 'address', 'broker_name', 'broker_phone', 'broker_team', 'receipt_number', 'date', 'party', 'amount_words',
  'payment_mode', 'details', 'declaration', 'qr', 'customer_signature',
  'authority_signature', 'printed_at', 'evidence',
]);

export const RECEIPT_DETAIL_ITEM_DEFAULTS = Object.freeze([
  { key: 'plot_buyer', label: 'Plot Buyer', sample: 'Sample Account Holder', enabled: true },
  { key: 'module', label: 'Account / Module', sample: 'Plot Payment · Plot A-18', enabled: true },
  { key: 'payment_mode', label: 'Payment Mode', sample: 'Cash', enabled: true },
  { key: 'reference', label: 'Reference', sample: 'Cash Book 18', enabled: true },
  { key: 'narration', label: 'Narration', sample: 'Installment received against account', enabled: true },
  { key: 'particulars', label: 'Particulars', sample: 'Transaction particulars', enabled: false },
  { key: 'transaction_time', label: 'Time (IST)', sample: '10:30 AM', enabled: true },
  { key: 'bank_account', label: 'Bank account', sample: 'Current account', enabled: true },
  { key: 'bank_name', label: 'Bank name', sample: 'Sample Bank', enabled: true },
  { key: 'account_no', label: 'Account number', sample: '1234567890', enabled: true },
  { key: 'branch', label: 'Branch', sample: 'Main branch', enabled: true },
  { key: 'ifsc', label: 'IFSC', sample: 'BANK0001234', enabled: true },
  { key: 'cheque_no', label: 'Cheque number', sample: '001247', enabled: true },
  { key: 'cheque_status', label: 'Cheque status', sample: 'PENDING', enabled: true },
  { key: 'category', label: 'Category', sample: 'Office', enabled: true },
  { key: 'sub_category', label: 'Sub-category', sample: 'Rent', enabled: true },
  { key: 'remarks', label: 'Remarks', sample: 'Monthly payment', enabled: true },
  { key: 'remark2', label: 'Additional remarks', sample: '', enabled: true },
  { key: 'related_party', label: 'Money related to', sample: 'Sample client', enabled: true },
  { key: 'assigned_to', label: 'Approver', sample: 'Accounts Admin', enabled: true },
  { key: 'status', label: 'Status', sample: 'APPROVED', enabled: true },
  { key: 'booking_reference', label: 'Booking', sample: 'BK-018', enabled: true },
  { key: 'plot_reference', label: 'Property', sample: 'A-18', enabled: true },
  { key: 'buyer_phone', label: 'Buyer phone', sample: '9876543210', enabled: true },
  { key: 'land_deal', label: 'Land deal', sample: 'LD-018', enabled: true },
  { key: 'from_entity', label: 'From', sample: 'Payer', enabled: true },
  { key: 'to_entity', label: 'To', sample: 'Payee', enabled: true },
  { key: 'firm', label: 'Firm', sample: 'Sample firm', enabled: true },
  { key: 'vendor', label: 'Vendor', sample: 'Sample vendor', enabled: true },
  { key: 'farmer', label: 'Land owner', sample: 'Sample owner', enabled: true },
  { key: 'agent', label: 'Agent', sample: 'Sample agent', enabled: true },
]);

const RECEIPT_NAME_ITEM_DEFAULTS = Object.freeze([
  { key: 'broker_name', label: 'Broker', sample: 'Rajesh Sharma' },
  { key: 'broker_phone', label: 'Phone', sample: '98765 43210' },
  { key: 'broker_team', label: 'Team', sample: 'North Team' },
]);

const FONT_FAMILIES = Object.freeze([
  'Inter', 'Georgia', 'Arial', 'Helvetica', 'Garamond', 'Times New Roman',
  'Trebuchet MS', 'Verdana', 'Courier New',
]);
const PAGE_SIZES = Object.freeze(['A4', 'A5']);
const HEX_COLOR = /^#[0-9a-f]{6}$/i;

const COMMON_FIELDS = Object.freeze({
  cheque_notice: true, title: true, amount: true, copy_label: true,
  broker_name: true,
  broker_phone: true,
  broker_team: true,
  organization: true,
  address: true,
  receipt_number: true,
  date: true,
  party: true,
  amount_words: true,
  payment_mode: true,
  details: true,
  declaration: true,
  qr: true,
  customer_signature: true,
  authority_signature: true,
  printed_at: true,
  evidence: true,
});

const modeDefaults = (mode) => {
  const base = baseModeDefaults(mode);
  if (mode === 'cheque_reconciliation') return {
    ...base,
    template_id: 'teal-modern', font_family: 'Trebuchet MS',
    colors: { ...base.colors, accent: '#0d9488', background: '#f6fffe' },
    fields: { ...base.fields, qr: false },
    detail_items: [
      ...base.detail_items.map((item) => item.key === 'payment_mode' ? { ...item, sample: 'CHEQUE' } : item),
      { key: 'cheque_no', label: 'Cheque number', sample: '001247', enabled: true },
      { key: 'cheque_status', label: 'Cheque status', sample: 'PENDING', enabled: true },
      { key: 'bank_account', label: 'Bank account', sample: 'Site current account', enabled: true },
      { key: 'plot_reference', label: 'Plot', sample: 'A-18', enabled: true },
      { key: 'booking_reference', label: 'Booking', sample: 'BK-018', enabled: true },
    ],
    content: {
      ...base.content, title: 'Cheque Reconciliation Receipt', amount_label: 'Cheque amount',
      declaration: 'This acknowledgement records the cheque instrument only. Payment is subject to realization and reconciliation in the books of account. E. & O.E.',
    },
  };
  if (mode !== 'cheque') return base;
  // Mirrors rgaccount/src/lib/receiptDesigner.js: cheque = non-cash layout
  // with its own identity + realization declaration.
  return {
    ...base,
    template_id: 'teal-modern',
    font_family: 'Trebuchet MS',
    colors: { ...base.colors, accent: '#0d9488', background: '#f6fffe' },
    detail_items: base.detail_items.map((item) => (
      item.key === 'payment_mode' ? { ...item, sample: 'Cheque' } : item
    )),
    content: {
      ...base.content,
      title: 'Cheque Receipt',
      amount_label: 'Cheque amount',
      declaration: 'This receipt is issued against a cheque and is valid subject to realization of the instrument and reconciliation in the books of account. E. & O.E.',
    },
  };
};

const baseModeDefaults = (mode) => ({
  layout_mode: 'preset',
  text_transform: 'none',
  elements: [],
  template_id: mode === 'cash' ? 'cash-simple' : 'executive-classic',
  page_size: mode === 'cash' ? 'A5' : 'A4',
  font_family: mode === 'cash' ? 'Arial' : 'Inter',
  base_font_size: mode === 'cash' ? 11 : 12,
  line_spacing: 100,
  heading_size: mode === 'cash' ? 26 : 30,
  amount_size: mode === 'cash' ? 34 : 48,
  colors: {
    primary: mode === 'cash' ? '#0f172a' : '#0f172a',
    accent: mode === 'cash' ? '#334155' : '#047857',
    text: '#111827',
    muted: '#64748b',
    background: '#ffffff', credit: '#059669', debit: '#dc2626',
  },
  fields: {
    ...COMMON_FIELDS,
    organization: mode !== 'cash',
    address: mode !== 'cash',
    qr: true,
    evidence: mode !== 'cash',
  },
  name_items: RECEIPT_NAME_ITEM_DEFAULTS.map((item) => ({ ...item })),
  detail_items: [
    ...[
      { key: 'plot_no', label: 'Plot No.', sample: 'A-18', enabled: true },
      { key: 'plot_size', label: 'Plot Size', sample: '120 sq. yd.', enabled: true },
      { key: 'plot_rate', label: 'Plot Rate', sample: '₹2,000', enabled: true },
      { key: 'received_by', label: 'Received By', sample: 'Amit Kumar', enabled: true },
    ],
    ...RECEIPT_DETAIL_ITEM_DEFAULTS.map((item) => ({
      ...item,
      sample: item.key === 'payment_mode' && mode !== 'cash' ? 'Bank Transfer' : item.sample,
    })),
  ],
  content: {
    title: mode === 'cash' ? 'Cash Receipt' : 'Payment Receipt',
    party_label: mode === 'cash' ? 'Received from' : 'Party / context',
    amount_label: mode === 'cash' ? 'Cash amount' : 'Transaction amount',
    details_label: 'Transaction particulars',
    declaration: mode === 'cash'
      ? 'This cash acknowledgement is valid subject to reconciliation and entry in the books of account. E. & O.E.'
      : 'This computer-generated receipt records the transaction particulars shown above and is valid subject to realization and reconciliation. E. & O.E.',
    footer: 'Generated from the accounts system',
    receipt_number_label: 'Receipt no.', date_label: 'Date', mode_label: 'Mode',
    customer_signature_label: 'Customer / Payee', authority_signature_label: mode === 'cash' ? 'Received by' : 'Authorized signatory',
    separator: ': ', currency_prefix: '₹ ', currency_suffix: '/-',
    words_prefix: 'Rupees ', words_suffix: ' Only',
    credit_label: 'Credit · Money in', debit_label: 'Debit · Money out',
    qr_label: 'Scan to verify', qr_placeholder: 'QR', qr_unavailable: 'Verification unavailable',
    evidence_label: 'Transaction evidence', evidence_note: 'Image attached when this transaction was recorded.',
    printed_label: ' · Printed on ', watermark_text: 'RECEIPT',
    original_label: 'ORIGINAL', duplicate_label: 'DUPLICATE', copy_separator: ' · #',
    cheque_status_label: 'Cheque status', cheque_pending_note: 'Pending realization. This is an acknowledgement of the cheque instrument.',
    organization_text: '', address_text: '', broker_empty_label: 'No broker assigned', contact_separator: ' · ',

  },
});

export const DEFAULT_RECEIPT_DESIGN = Object.freeze({
  version: 2,
  modules: {},
  cash: modeDefaults('cash'),
  cheque: modeDefaults('cheque'),
  cheque_reconciliation: modeDefaults('cheque_reconciliation'),
  non_cash: modeDefaults('non_cash'),
});

const isObject = (value) => value && typeof value === 'object' && !Array.isArray(value);
const cleanText = (value, fallback, maxLength) => {
  if (typeof value !== 'string') return fallback;
  const text = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
  return text.slice(0, maxLength);
};
const cleanNumber = (value, fallback, min, max) => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.round(number))) : fallback;
};

const normalizeMode = (value, mode) => {
  const defaults = modeDefaults(mode);
  const input = isObject(value) ? value : {};
  const colors = isObject(input.colors) ? input.colors : {};
  const fields = isObject(input.fields) ? input.fields : {};
  const content = isObject(input.content) ? input.content : {};
  const detailItems = Array.isArray(input.detail_items) ? input.detail_items : [];
  // Designs saved before Narration was a first-class field used Particulars
  // for the same value. Keep Particulars available, but hide that legacy row
  // when adding Narration so existing receipts do not print the text twice.
  const normalizedInputDetailItems = detailItems.some((item) => item?.key === 'narration')
    ? detailItems
    : detailItems.map((item) => item?.key === 'particulars' ? { ...item, enabled: false } : item);
  const nameItems = Array.isArray(input.name_items) ? input.name_items : [];
  const plainCashTemplate = ['cash-plain-note', 'cash-plain-slip', 'cash-plain-letter'].includes(input.template_id);
  const isPlainCash = mode === 'cash' && plainCashTemplate;

  const normalizedFields = {};
  for (const key of RECEIPT_FIELD_KEYS) {
    normalizedFields[key] = typeof fields[key] === 'boolean' ? fields[key] : defaults.fields[key];
  }



  return {
    text_transform: ['uppercase','lowercase'].includes(input.text_transform) ? input.text_transform : 'none',
    layout_mode: input.layout_mode === 'canvas' ? 'canvas' : 'preset',
    elements: normalizeCanvasElements(input.elements, input.page_size),
    template_id: RECEIPT_TEMPLATE_IDS.includes(input.template_id) && (!plainCashTemplate || isPlainCash)
      ? input.template_id
      : defaults.template_id,
    page_size: PAGE_SIZES.includes(input.page_size) ? input.page_size : defaults.page_size,
    font_family: FONT_FAMILIES.includes(input.font_family) ? input.font_family : defaults.font_family,
    base_font_size: cleanNumber(input.base_font_size, defaults.base_font_size, 8, 18),
    // Percent of the template's vertical spacing; the client clamps to the same 70–160 range.
    line_spacing: cleanNumber(input.line_spacing, defaults.line_spacing, 70, 160),
    heading_size: cleanNumber(input.heading_size, defaults.heading_size, isPlainCash ? 8 : 18, 48),
    amount_size: cleanNumber(input.amount_size, defaults.amount_size, isPlainCash ? 8 : 22, 72),
    colors: Object.fromEntries(Object.entries(defaults.colors).map(([key, fallback]) => [
      key,
      typeof colors[key] === 'string' && HEX_COLOR.test(colors[key]) ? colors[key].toLowerCase() : fallback,
    ])),
    fields: normalizedFields,
    name_items: defaults.name_items.map((fallback) => {
      const candidate = nameItems.find((item) => isObject(item) && item.key === fallback.key) || {};
      return {
        key: fallback.key,
        label: cleanText(candidate.label, fallback.label, 80),
        sample: cleanText(candidate.sample, fallback.sample, 140),
      };
    }),
    detail_items: [...(normalizedInputDetailItems.length ? normalizedInputDetailItems : defaults.detail_items), ...defaults.detail_items.filter(item => !normalizedInputDetailItems.some(row => row?.key === item.key))]
      .filter((item, index, all) => isObject(item) && /^[a-z][a-z0-9_]{0,79}$/.test(item.key) && all.findIndex(row => row?.key === item.key) === index)
      .slice(0, 120).map((item) => ({ key: item.key,
        label: cleanText(item.label, item.key, 80), sample: cleanText(item.sample, '', 300), enabled: item.enabled !== false,
      })),
    content: Object.fromEntries(Object.entries(defaults.content).map(([key, fallback]) => [key,
      typeof content[key] === 'string' ? content[key].replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').slice(0, 2000) : fallback,
    ])),
  };
};

export const normalizeReceiptDesign = (value) => ({
  version: 2,
  ...Object.fromEntries(['cash', 'cheque', 'cheque_reconciliation', 'non_cash'].map(mode => [mode, normalizeMode(value?.[mode], mode)])),
  modules: Object.fromEntries(Object.entries(isObject(value?.modules) ? value.modules : {})
    .filter(([key, modes]) => /^[a-z][a-z0-9_]{0,79}$/.test(key) && isObject(modes)).slice(0, 50)
    .map(([key, modes]) => [key, Object.fromEntries(['cash', 'cheque', 'cheque_reconciliation', 'non_cash']
      .filter(mode => isObject(modes[mode])).map(mode => [mode, normalizeMode(modes[mode], mode)]))])),
});

// Every site reads one app-wide design. Legacy site settings stay intact for rollback.
export const getReceiptDesign = async () => {
  const shared = await applicationSettingModel.getGlobalJson(RECEIPT_DESIGN_KEY, null);
  if (shared) return normalizeReceiptDesign(shared);
  const { rows } = await pool.query(`SELECT a.setting_value FROM application_settings a
    JOIN sites s ON s.id = a.site_id WHERE a.setting_key = $1 AND upper(trim(s.name)) = 'OM ASSOCIATES'
    ORDER BY a.updated_at DESC, a.id DESC LIMIT 1`, [RECEIPT_DESIGN_KEY]);
  return normalizeReceiptDesign(rows[0]?.setting_value || DEFAULT_RECEIPT_DESIGN);
};

export const saveReceiptDesign = async (_siteId, value, updatedBy) => {
  const normalized = normalizeReceiptDesign(value);
  return applicationSettingModel.setGlobalJson(RECEIPT_DESIGN_KEY, normalized, updatedBy);
};
