import asyncHandler from '../utils/asyncHandler.js';
import pool from '../config/db.js';
import { DOCUMENTATION_TARGETS, documentationSource, documentationId, documentationError, documentationPermission, documentationRecord, readDocumentation, saveDocumentation, presentDocumentation, listDocumentationGaps, readDocumentationBatch } from '../services/transactionDocumentation.service.js';
const isAdmin = user => ['admin', 'super_admin'].includes(user?.role);
async function siteAccess(user, value, database = pool) {
  const siteId = documentationId(value);
  const {
    rows
  } = await database.query(`SELECT id FROM sites s WHERE id=$1 AND organization_id=$2
    ${isAdmin(user) ? '' : 'AND EXISTS(SELECT 1 FROM user_sites us WHERE us.site_id=s.id AND us.user_id=$3)'}`, isAdmin(user) ? [siteId, Number(user.organization_id) || 1] : [siteId, Number(user.organization_id) || 1, user.id]);
  if (!rows[0]) throw documentationError('Access denied to this site.', 403);
  return siteId;
}
export const getDocumentation = asyncHandler(async (req, res) => {
  const ref = await documentationRecord(req.user, req.params.source, req.params.id);
  res.set?.('Cache-Control', 'no-store');
  res.json({
    documentation: await readDocumentation(ref, req.user, pool, {
      history: true
    })
  });
});
export const putDocumentation = asyncHandler(async (req, res) => {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const documentation = await saveDocumentation(req.user, req.params.source, req.params.id, req.body, db);
    await db.query('COMMIT');
    res.json({
      documentation
    });
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  } finally {
    db.release();
  }
});
export const batchDocumentation = asyncHandler(async (req, res) => {
  const records = req.body?.records;
  if (!Array.isArray(records) || records.length > 500) throw documentationError('Request at most 500 transaction records.');
  res.json({
    documentation: await readDocumentationBatch(req.user, records)
  });
});
export const getDocumentationDefaults = asyncHandler(async (req, res) => {
  const source = documentationSource(req.query.source),
    site = await siteAccess(req.user, req.query.site_id);
  if (!(await documentationPermission(req.user, source, 'write'))) throw documentationError('You cannot create transactions in this module.', 403);
  const {
    rows
  } = await pool.query('SELECT transaction_documentation_state($1,0,$2,$3::jsonb) AS documentation', [source, site, JSON.stringify({
    transaction_type: req.query.transaction_type || undefined,
    payment_mode: req.query.payment_mode || 'CASH',
    credit: req.query.direction === 'credit' ? 1 : 0
  })]);
  res.json({
    documentation: presentDocumentation(rows[0].documentation, true)
  });
});
export const getDocumentationPolicies = asyncHandler(async (req, res) => {
  const site = await siteAccess(req.user, req.query.site_id);
  const {
    rows
  } = await pool.query('SELECT * FROM transaction_documentation_policies WHERE site_id=$1 ORDER BY source,transaction_type', [site]);
  const sources = [];
  for (const source of Object.keys(DOCUMENTATION_TARGETS)) if (await documentationPermission(req.user, source)) sources.push({
    source,
    label: source.replaceAll('_', ' ')
  });
  res.json({
    policies: rows.filter(row => sources.some(item => item.source === row.source)),
    sources,
    can_edit: isAdmin(req.user)
  });
});
export const putDocumentationPolicy = asyncHandler(async (req, res) => {
  if (!isAdmin(req.user)) throw documentationError('Only an administrator can configure documentation policy.', 403);
  const source = documentationSource(req.params.source);
  if (!DOCUMENTATION_TARGETS[source]) throw documentationError('Unsupported transaction source.');
  const body = req.body || {},
    site = await siteAccess(req.user, body.site_id),
    type = String(body.transaction_type || '*').trim().toLowerCase();
  if (!type || type.length > 100) throw documentationError('Choose a valid transaction type.');
  for (const key of ['bill_required', 'voucher_required', 'bill_locked', 'voucher_locked']) if (typeof (body[key] ?? (key.endsWith('_locked') ? false : undefined)) !== 'boolean') throw documentationError(`${key} must be a boolean.`);
  if (body.bill_locked && !body.bill_required || body.voucher_locked && !body.voucher_required) throw documentationError('A mandatory document must be required.');
  const version = body.version ?? 0;
  if (!Number.isSafeInteger(version) || version < 0) throw documentationError('Supply a valid policy version.');
  if (typeof (body.reason ?? '') !== 'string' || (body.reason || '').length > 2000) throw documentationError('The policy reason must be at most 2,000 characters.');
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`documentation-policy:${site}:${source}`]);
    const before = (await db.query('SELECT * FROM transaction_documentation_policies WHERE site_id=$1 AND source=$2 AND transaction_type=$3 FOR UPDATE', [site, source, type])).rows[0];
    if ((before?.version || 0) !== version) throw documentationError('This policy changed in another session. Reload before saving.', 409, 'DOCUMENTATION_CONFLICT');
    const {
      rows
    } = await db.query(`INSERT INTO transaction_documentation_policies(site_id,source,transaction_type,bill_required,voucher_required,bill_locked,voucher_locked,reason,updated_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(site_id,source,transaction_type) DO UPDATE SET
      bill_required=EXCLUDED.bill_required,voucher_required=EXCLUDED.voucher_required,bill_locked=EXCLUDED.bill_locked,voucher_locked=EXCLUDED.voucher_locked,
      reason=EXCLUDED.reason,updated_by=EXCLUDED.updated_by,updated_at=now(),version=transaction_documentation_policies.version+1 RETURNING *`, [site, source, type, body.bill_required, body.voucher_required, body.bill_locked || false, body.voucher_locked || false, body.reason?.trim() || '', req.user.id]);
    await db.query(`INSERT INTO transaction_documentation_history(site_id,source,transaction_type,actor_id,actor_name,reason,changes,event_type)
      VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,'policy')`, [site, source, type, req.user.id, req.user.name || null, body.reason || '', JSON.stringify({
      before: before || null,
      after: rows[0]
    })]);
    await db.query('COMMIT');
    res.json({
      policy: rows[0]
    });
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  } finally {
    db.release();
  }
});
export const getDocumentationGaps = asyncHandler(async (req, res) => {
  const entries = await listDocumentationGaps(req.user, {
    ...req.query,
    date_from: req.query.date_from || req.query.from_date,
    date_to: req.query.date_to || req.query.to_date
  });
  res.set?.('Cache-Control', 'no-store');
  res.json({
    entries,
    counts: {
      total: entries.length,
      missing_bill: entries.filter(row => row.documentation.missing_bill).length,
      missing_voucher: entries.filter(row => row.documentation.missing_voucher).length,
      missing_both: entries.filter(row => row.documentation.status === 'missing_both').length
    }
  });
});
