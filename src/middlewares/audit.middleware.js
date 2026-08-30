import crypto from 'crypto';
import {
  attributeRecycleBinDeletion, sanitizeAuditValue, writeAuditLog,
} from '../services/auditLog.service.js';

const METHOD_ACTION = { POST: 'CREATE', PUT: 'UPDATE', PATCH: 'UPDATE', DELETE: 'DELETE' };
const ACTION_WORDS = new Map([
  ['bulk-delete', 'DELETE'], ['delete', 'DELETE'], ['approve', 'APPROVE'],
  ['reject', 'REJECT'], ['transfer', 'TRANSFER'], ['logout', 'LOGOUT'],
  ['upload', 'UPLOAD'], ['send', 'SEND'], ['restore', 'RESTORE'],
  ['archive', 'ARCHIVE'], ['cancel', 'CANCEL'], ['return', 'RETURN'],
]);
const MODULE_MAP = {
  auth: 'authentication', admin: 'administration', sites: 'sites', farmers: 'farmers',
  commissions: 'commissions', 'land-deals': 'land_deals', 'misc-income': 'misc_income', 'plot-commission': 'plot_commission', cashflow: 'cashflow',
  firms: 'firm_transactions', plots: 'plot_payments', 'plot-documents': 'plot_payments',
  documents: 'document_search', 'record-documents': 'document_search', forecast: 'finance_forecast',
  expenses: 'expenses', registries: 'plot_registry', members: 'clients', 'member-kyc': 'clients',
  daybook: 'daybook', banks: 'cashflow', imprest: 'imprest', 'document-imprest': 'document_imprest',
  'edit-requests': 'edit_approvals', permissions: 'permissions', 'member-categories': 'clients',
  'expense-categories': 'expenses', activity: 'activity', excel: 'excel', folders: 'excel',
  approvals: 'approvals', chat: 'chat', vendors: 'vendors', 'dashboard-permissions': 'dashboard',
  upi: 'upi_collect', signatures: 'signatures', 'balance-sheet': 'balance_sheet', settings: 'settings',
  compliance: 'compliance', 'compliance-documents': 'compliance', construction: 'construction',
  inventory: 'inventory', reports: 'reports', 'pending-lookout': 'approvals',
  'transaction-transfers': 'transaction_transfers', upload: 'uploads',
  'bank-reconciliation': 'bank_reconciliation', 'management-analytics': 'management_analytics',
  'recycle-bin': 'recycle_bin',
};

const labelize = (value) => String(value || '')
  .replace(/[-_]+/g, ' ')
  .replace(/\b\w/g, (letter) => letter.toUpperCase());

const segmentsOf = (req) => String(req.path || req.originalUrl || '')
  .split('?')[0].split('/').filter(Boolean);

const findNested = (value, keys, depth = 0) => {
  if (value == null || depth > 4) return null;
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 10)) {
      const found = findNested(item, keys, depth + 1);
      if (found != null) return found;
    }
    return null;
  }
  if (typeof value !== 'object') return null;
  for (const key of keys) {
    const foundKey = Object.keys(value).find((candidate) => candidate.toLowerCase() === key);
    if (foundKey && value[foundKey] != null && value[foundKey] !== '') return value[foundKey];
  }
  for (const item of Object.values(value)) {
    const found = findNested(item, keys, depth + 1);
    if (found != null) return found;
  }
  return null;
};

const resolveAction = (method, segments) => {
  const joined = segments.join('/').toLowerCase();
  for (const [word, action] of ACTION_WORDS) {
    if (joined.includes(word)) return action;
  }
  return METHOD_ACTION[method] || 'EVENT';
};

const resolveEntityId = (segments, requestBody, responseBody) => {
  const routeId = [...segments].reverse().find((part) => /^\d+$/.test(part));
  if (routeId) return routeId;
  return findNested(responseBody, ['id', 'entry_id', 'payment_id', 'transaction_id', 'request_id'])
    ?? findNested(requestBody, ['id', 'entry_id', 'payment_id', 'transaction_id']);
};

const resolveSiteId = (req, responseBody) => findNested(req.body, ['site_id', 'siteid'])
  ?? findNested(req.query, ['site_id', 'siteid'])
  ?? findNested(responseBody, ['site_id', 'siteid']);

const resolveTransactionName = (requestBody, responseBody) => {
  const keys = [
    'transaction_name', 'expense_name', 'particular', 'description', 'remark', 'reason',
    'title', 'plot_no', 'payment_from', 'narration', 'to_entity', 'from_entity', 'entity_name', 'name', 'category',
  ];
  const value = findNested(requestBody, keys) ?? findNested(responseBody, keys);
  if (value == null || typeof value === 'object') return null;
  const name = String(value).trim();
  return name ? name.slice(0, 500) : null;
};

const resolveAmount = (requestBody, responseBody) => {
  const keys = ['amount', 'total_amount', 'paid_amount', 'payment_amount', 'debit', 'credit', 'value'];
  for (const source of [requestBody, responseBody]) {
    for (const key of keys) {
      const value = findNested(source, [key]);
      const amount = Number(value);
      if (value != null && Number.isFinite(amount) && Math.abs(amount) > 0 && Math.abs(amount) < 1e15) {
        return Math.abs(amount);
      }
    }
  }
  return null;
};

export default function auditRequestMiddleware(req, res, next) {
  const method = String(req.method || '').toUpperCase();
  const segments = segmentsOf(req);
  if (!METHOD_ACTION[method] || segments[0] === 'audit-logs' || segments[0] === 'receipt-history') return next();
  if (segments[0] === 'graphql' && !/^\s*mutation\b/i.test(String(req.body?.query || ''))) return next();

  const startedAt = Date.now();
  const requestId = crypto.randomUUID();
  let responseBody = null;
  const originalJson = res.json.bind(res);
  res.json = (body) => {
    responseBody = sanitizeAuditValue(body);
    return originalJson(body);
  };

  res.once('finish', () => {
    const actor = req.user;
    if (!actor?.id) return;

    const action = resolveAction(method, segments);
    const root = segments[0] || 'system';
    const module = MODULE_MAP[root] || root.replaceAll('-', '_');
    const entityType = segments.find((part, index) => index > 0 && !/^\d+$/.test(part) && !ACTION_WORDS.has(part.toLowerCase())) || root;
    const entityId = resolveEntityId(segments, req.body, responseBody);
    const siteId = resolveSiteId(req, responseBody);
    const outcome = res.statusCode >= 200 && res.statusCode < 400 ? 'SUCCESS' : 'FAILURE';
    const verb = outcome === 'SUCCESS' ? action.toLowerCase() : `failed to ${action.toLowerCase()}`;
    const description = `${labelize(actor.email || `User ${actor.id}`)} ${verb} ${labelize(entityType)}${entityId != null ? ` #${entityId}` : ''}`;
    const transactionName = resolveTransactionName(req.body, responseBody);
    const amount = resolveAmount(req.body, responseBody);
    const finishedAt = Date.now();

    setImmediate(() => {
      const auditEntry = {
        organizationId: actor.organization_id,
        siteId,
        userId: actor.id,
        action,
        eventType: 'HTTP',
        module,
        transactionName,
        amount,
        entityType,
        entityId,
        requestMethod: method,
        requestPath: req.originalUrl || req.path,
        statusCode: res.statusCode,
        outcome,
        description,
        newValues: {
          request: sanitizeAuditValue(req.body || {}),
          response: responseBody,
        },
        metadata: {
          query: sanitizeAuditValue(req.query || {}),
          duration_ms: Date.now() - startedAt,
          session_id: req.sessionId || null,
        },
        ipAddress: req.headers['x-forwarded-for'] || req.ip || req.socket?.remoteAddress,
        userAgent: req.get('user-agent'),
        requestId,
      };
      const writes = [writeAuditLog(auditEntry)];
      if (action === 'DELETE' && outcome === 'SUCCESS') {
        writes.push(attributeRecycleBinDeletion({
          organizationId: actor.organization_id,
          userId: actor.id,
          module,
          entityId,
          startedAt,
          finishedAt,
        }));
      }
      Promise.all(writes).catch((error) => console.error('[audit] write failed:', error.message));
    });
  });

  next();
}
