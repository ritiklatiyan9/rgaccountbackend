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
  'organization', 'address', 'broker_name', 'broker_phone', 'broker_team', 'receipt_number', 'date', 'party', 'amount_words',
  'payment_mode', 'details', 'declaration', 'qr', 'customer_signature',
  'authority_signature', 'printed_at', 'evidence',
]);

export const RECEIPT_DETAIL_ITEM_DEFAULTS = Object.freeze([
  { key: 'plot_buyer', label: 'Plot Buyer', sample: 'Sample Account Holder', enabled: true },
  { key: 'module', label: 'Account / Module', sample: 'Plot Payment · Plot A-18', enabled: true },
  { key: 'payment_mode', label: 'Payment Mode', sample: 'Cash', enabled: true },
  { key: 'reference', label: 'Reference', sample: 'Cash Book 18', enabled: true },
  { key: 'particulars', label: 'Particulars', sample: 'Installment received against account', enabled: true },
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
  template_id: mode === 'cash' ? 'cash-simple' : 'executive-classic',
  page_size: mode === 'cash' ? 'A5' : 'A4',
  font_family: mode === 'cash' ? 'Arial' : 'Inter',
  base_font_size: mode === 'cash' ? 11 : 12,
  heading_size: mode === 'cash' ? 26 : 30,
  amount_size: mode === 'cash' ? 34 : 48,
  colors: {
    primary: mode === 'cash' ? '#0f172a' : '#0f172a',
    accent: mode === 'cash' ? '#334155' : '#047857',
    text: '#111827',
    muted: '#64748b',
    background: '#ffffff',
  },
  fields: {
    ...COMMON_FIELDS,
    organization: mode !== 'cash',
    address: mode !== 'cash',
    qr: true,
    evidence: mode !== 'cash',
  },
  name_items: mode === 'cash' ? RECEIPT_NAME_ITEM_DEFAULTS.map((item) => ({ ...item })) : [],
  detail_items: [
    ...(mode === 'cash' ? [
      { key: 'plot_no', label: 'Plot No.', sample: 'A-18', enabled: true },
      { key: 'plot_size', label: 'Plot Size', sample: '120 sq. yd.', enabled: true },
      { key: 'received_by', label: 'Received By', sample: 'Amit Kumar', enabled: true },
    ] : []),
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
  },
});

export const DEFAULT_RECEIPT_DESIGN = Object.freeze({
  version: 1,
  cash: modeDefaults('cash'),
  cheque: modeDefaults('cheque'),
  non_cash: modeDefaults('non_cash'),
});

const clone = (value) => JSON.parse(JSON.stringify(value));
const isObject = (value) => value && typeof value === 'object' && !Array.isArray(value);
const cleanText = (value, fallback, maxLength) => {
  if (typeof value !== 'string') return fallback;
  const text = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, maxLength) : fallback;
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
  const nameItems = Array.isArray(input.name_items) ? input.name_items : [];
  const plainCashTemplate = ['cash-plain-note', 'cash-plain-slip', 'cash-plain-letter'].includes(input.template_id);
  const isPlainCash = mode === 'cash' && plainCashTemplate;

  const normalizedFields = {};
  for (const key of RECEIPT_FIELD_KEYS) {
    normalizedFields[key] = typeof fields[key] === 'boolean' ? fields[key] : defaults.fields[key];
  }

  // Cash receipts never print the company identity, including legacy designs.
  if (mode === 'cash') {
    normalizedFields.organization = false;
    normalizedFields.address = false;
  }

  return {
    template_id: RECEIPT_TEMPLATE_IDS.includes(input.template_id) && (!plainCashTemplate || isPlainCash)
      ? input.template_id
      : defaults.template_id,
    page_size: PAGE_SIZES.includes(input.page_size) ? input.page_size : defaults.page_size,
    font_family: FONT_FAMILIES.includes(input.font_family) ? input.font_family : defaults.font_family,
    base_font_size: cleanNumber(input.base_font_size, defaults.base_font_size, 8, 18),
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
    detail_items: defaults.detail_items.map((fallback) => {
      const candidate = detailItems.find((item) => isObject(item) && item.key === fallback.key) || {};
      return {
        key: fallback.key,
        label: cleanText(candidate.label, fallback.label, 80),
        sample: cleanText(candidate.sample, fallback.sample, 140),
        enabled: typeof candidate.enabled === 'boolean' ? candidate.enabled : fallback.enabled,
      };
    }),
    content: {
      title: cleanText(content.title, defaults.content.title, 80),
      party_label: cleanText(content.party_label, defaults.content.party_label, 80),
      amount_label: cleanText(content.amount_label, defaults.content.amount_label, 80),
      details_label: cleanText(content.details_label, defaults.content.details_label, 80),
      declaration: cleanText(content.declaration, defaults.content.declaration, 500),
      footer: cleanText(content.footer, defaults.content.footer, 180),
    },
  };
};

export const normalizeReceiptDesign = (value) => ({
  version: 1,
  cash: normalizeMode(isObject(value) ? value.cash : null, 'cash'),
  cheque: normalizeMode(isObject(value) ? value.cheque : null, 'cheque'),
  non_cash: normalizeMode(isObject(value) ? value.non_cash : null, 'non_cash'),
});

export const getReceiptDesign = async (siteId) => {
  const stored = await applicationSettingModel.getJson(siteId, RECEIPT_DESIGN_KEY, null);
  return stored ? normalizeReceiptDesign(stored) : clone(DEFAULT_RECEIPT_DESIGN);
};

export const saveReceiptDesign = async (siteId, value, updatedBy) => {
  const normalized = normalizeReceiptDesign(value);
  return applicationSettingModel.setJson(siteId, RECEIPT_DESIGN_KEY, normalized, updatedBy);
};
