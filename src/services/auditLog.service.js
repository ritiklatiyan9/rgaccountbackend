import crypto from 'crypto';
import pool from '../config/db.js';

const REDACTED_KEY = /(password|passcode|token|secret|authorization|credential|otp|signature|private[_-]?key|refresh[_-]?token)/i;
const BINARY_KEY = /(file|photo|image|document_blob|binary|base64)/i;
const MAX_DEPTH = 5;
const MAX_KEYS = 80;
const MAX_ARRAY = 50;
const MAX_STRING = 1200;
const MAX_SERIALIZED_LENGTH = 64_000;

export function sanitizeAuditValue(value, depth = 0) {
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (depth >= MAX_DEPTH) return '[depth limit]';
  if (typeof value === 'string') {
    if (value.startsWith('data:') || value.length > 25_000) return '[large payload omitted]';
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
  }
  if (Array.isArray(value)) {
    const rows = value.slice(0, MAX_ARRAY).map((item) => sanitizeAuditValue(item, depth + 1));
    if (value.length > MAX_ARRAY) rows.push(`[${value.length - MAX_ARRAY} more items]`);
    return rows;
  }
  if (typeof value === 'object') {
    const output = {};
    for (const [key, item] of Object.entries(value).slice(0, MAX_KEYS)) {
      if (REDACTED_KEY.test(key)) output[key] = '[redacted]';
      else if (BINARY_KEY.test(key) && typeof item === 'string' && (item.startsWith('data:') || item.length > 2000)) output[key] = '[binary omitted]';
      else output[key] = sanitizeAuditValue(item, depth + 1);
    }
    return output;
  }
  return String(value);
}

const prepareAuditJson = (value) => {
  const sanitized = sanitizeAuditValue(value);
  try {
    if (JSON.stringify(sanitized).length > MAX_SERIALIZED_LENGTH) {
      return { _omitted: 'audit payload exceeded 64 KB' };
    }
  } catch {
    return { _omitted: 'audit payload could not be serialized' };
  }
  return sanitized;
};

export async function writeAuditLog(entry, db = pool) {
  const requestId = entry.requestId || crypto.randomUUID();
  const result = await db.query(
    `INSERT INTO audit_logs (
       organization_id, site_id, user_id, action, event_type, module,
       transaction_name, amount, entity_type, entity_id, request_method, request_path, status_code,
       outcome, description, old_values, new_values, metadata,
       ip_address, user_agent, request_id
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21
     ) RETURNING id, request_id`,
    [
      Number(entry.organizationId) || 1,
      Number(entry.siteId) || null,
      Number(entry.userId) || null,
      String(entry.action || 'EVENT').toUpperCase(),
      String(entry.eventType || 'HTTP').toUpperCase(),
      String(entry.module || 'system').slice(0, 80),
      entry.transactionName ? String(entry.transactionName).slice(0, 500) : null,
      entry.amount == null || !Number.isFinite(Number(entry.amount)) ? null : Number(entry.amount),
      entry.entityType ? String(entry.entityType).slice(0, 100) : null,
      entry.entityId != null ? String(entry.entityId).slice(0, 120) : null,
      entry.requestMethod ? String(entry.requestMethod).slice(0, 10) : null,
      entry.requestPath ? String(entry.requestPath).slice(0, 2000) : null,
      Number.isInteger(entry.statusCode) ? entry.statusCode : null,
      entry.outcome === 'FAILURE' ? 'FAILURE' : 'SUCCESS',
      String(entry.description || 'Application event').slice(0, 4000),
      entry.oldValues == null ? null : prepareAuditJson(entry.oldValues),
      entry.newValues == null ? null : prepareAuditJson(entry.newValues),
      prepareAuditJson(entry.metadata || {}),
      entry.ipAddress ? String(entry.ipAddress).split(',')[0].trim().slice(0, 80) : null,
      entry.userAgent ? String(entry.userAgent).slice(0, 2000) : null,
      requestId,
    ]
  );
  return result.rows[0];
}
