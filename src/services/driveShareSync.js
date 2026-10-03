import { createHash } from 'node:crypto';

// Bump when the generated statement/profile layout or included columns change
// so already-shared files receive that new rendering on their next sync.
const CONTENT_VERSION = 1;
const IDENTITY_VERSION = 1;
const FORMATS = new Set(['doc', 'pdf', 'xlsx']);
const GENERATED_KINDS = new Set(['statement', 'profile']);
const ATTACHMENT_KINDS = new Set(['document', 'voucher', 'signature']);

const canonical = (value) => {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => [key, canonical(value[key])]));
  }
  return value;
};
const digest = (value) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const pick = (row, keys) => Object.fromEntries(keys.map((key) => [key, row?.[key] ?? null]));
const identifier = (value) => {
  const text = String(value ?? '').trim();
  return /^\d+$/.test(text) ? BigInt(text).toString() : text;
};
const dateOnly = (value) => {
  if (value instanceof Date) {
    // Match fmtDate's local DATE interpretation, not UTC conversion.
    if (Number.isNaN(value.getTime())) return '';
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
  }
  if (!value) return '';
  return /^(\d{4}-\d{2}-\d{2})/.exec(String(value))?.[1] || String(value);
};
const visibilityIdentity = (visibility) => ({
  canViewAll: visibility.canViewAll === true,
  creatorIds: visibility.creatorId == null
    ? null
    : [...new Set((Array.isArray(visibility.creatorId) ? visibility.creatorId : String(visibility.creatorId).split(','))
      .map(identifier))].sort(),
});
const assertGenerated = (item, format) => {
  if (!GENERATED_KINDS.has(item?.kind) || !FORMATS.has(format) || (item.kind === 'profile' && format === 'xlsx')) {
    throw new TypeError('A supported generated statement/profile format is required');
  }
};
const attachmentSource = (source) => {
  const value = String(source ?? '').trim();
  if (!value) throw new TypeError('A stable attachment source is required for a Drive file identity');
  if (!/^https:\/\//i.test(value)) return value;
  const url = new URL(value);
  // Expiring access signatures identify a request, not a different stored file.
  url.search = '';
  url.hash = '';
  return url.toString();
};

const SITE_FIELDS = ['name', 'city', 'state'];
const PLOT_FIELDS = ['plot_no', 'buyer_name', 'block', 'plot_size', 'plot_size_mtr', 'plot_rate', 'sale_price', 'booking_date', 'status', 'commission_rate', 'team'];
const TOTAL_FIELDS = ['total_commission', 'total_paid', 'tds_total', 'balance', 'payment_count'];
const PAYMENT_FIELDS = ['id', 'date', 'agent_name', 'payment_mode', 'bank_name', 'cheque_no', 'transaction_id', 'amount', 'tds_amount', 'status', 'cheque_status', 'remarks'];
const XLSX_PAYMENT_FIELDS = [...PAYMENT_FIELDS, 'tds_section', 'created_by_name', 'approved_by_name'];
const STATEMENT_AGENT_FIELDS = ['agent_name', 'phone', 'pan_no', 'bank_name', 'account_no', 'ifsc_code', 'total_commission', 'total_paid', 'balance'];
const XLSX_AGENT_FIELDS = [...STATEMENT_AGENT_FIELDS, 'email', 'aadhaar_masked', 'branch', 'status'];
const PROFILE_AGENT_FIELDS = [...XLSX_AGENT_FIELDS, 'alt_phone', 'address', 'team', 'license_number', 'commission_rate', 'remarks'];

/** Hash the information that a generated file displays. Generated timestamps,
 * uploader names, receipt verification URLs and attachment storage locations
 * deliberately do not invalidate otherwise identical accounting content.
 * Attachment bytes need their own content digest; do not use this for them. */
export const generatedContentHash = (bundle, item, format) => {
  assertGenerated(item, format);
  const profile = item.kind === 'profile';
  const xlsx = format === 'xlsx';
  const plot = pick(bundle.plot, profile ? ['plot_no'] : xlsx ? ['plot_no', 'buyer_name'] : PLOT_FIELDS);
  if ('booking_date' in plot) plot.booking_date = dateOnly(plot.booking_date);
  const content = {
    version: CONTENT_VERSION, kind: item.kind, format,
    scope: bundle.scope || 'overall',
    payment_id: bundle.payment ? identifier(bundle.payment.id) : null,
    site: pick(bundle.site, profile ? ['name', 'city'] : SITE_FIELDS),
    plot,
    agents: (bundle.agents || []).map((agent) => pick(agent, profile ? PROFILE_AGENT_FIELDS : xlsx ? XLSX_AGENT_FIELDS : STATEMENT_AGENT_FIELDS)),
  };
  if (bundle.entryVisibility) content.visibility = visibilityIdentity(bundle.entryVisibility);
  if (!profile) {
    content.totals = pick(bundle.totals, TOTAL_FIELDS);
    content.payments = (bundle.payment ? [bundle.payment] : bundle.allPayments || []).map((payment) => ({
      ...pick(payment, xlsx ? XLSX_PAYMENT_FIELDS : PAYMENT_FIELDS),
      id: identifier(payment.id), date: dateOnly(payment.date),
    }));
  }
  return digest(content);
};

/** Stable file identity across dates, folder/name changes and people
 * requesting the same visible data. Scope, payment and visibility are part of
 * the identity so a restricted transaction can never replace a full statement.
 * A 64-byte hex digest leaves room for a Drive appProperties key (124-byte
 * combined key/value limit). No names, source URLs or personal data are stored. */
export const logicalFileKey = ({ share, item, format, visibility }) => {
  const attachment = ATTACHMENT_KINDS.has(item?.kind) && format === 'binary';
  if (!attachment) assertGenerated(item, format);
  if (!visibility || typeof visibility.canViewAll !== 'boolean') {
    throw new TypeError('Resolved entry visibility is required for a Drive file identity');
  }
  const organizationId = identifier(share.organization_id);
  const siteId = identifier(share.site_id);
  const entityId = identifier(share.entity_id);
  const scope = share.scope || 'overall';
  const paymentId = scope === 'transaction' ? identifier(share.payment_id) : null;
  if (!organizationId || !siteId || !entityId || (scope === 'transaction' && !paymentId)) {
    throw new TypeError('Organization, site, entity and scoped payment identity are required');
  }
  const identity = {
    version: IDENTITY_VERSION,
    organization_id: organizationId, site_id: siteId,
    module: share.module || 'plot_commission', entity_type: share.entity_type || 'plot', entity_id: entityId,
    scope, payment_id: paymentId, visibility: visibilityIdentity(visibility), kind: item.kind, format,
  };
  if (attachment) {
    identity.source = attachmentSource(item.source);
    identity.attachment_payment_id = item.payment_id == null ? null : identifier(item.payment_id);
  }
  return digest(identity);
};

/** Count known sync outcomes; legacy successful rows with no recorded action
 * stay unclassified rather than inventing whether they created or updated. */
export const shareSyncSummary = (files = []) => {
  const summary = { created: 0, updated: 0, unchanged: 0, failed: 0 };
  for (const file of files) {
    if (file?.error || file?.action === 'failed') summary.failed += 1;
    else if (['created', 'updated', 'unchanged'].includes(file?.action)) summary[file.action] += 1;
  }
  return summary;
};
