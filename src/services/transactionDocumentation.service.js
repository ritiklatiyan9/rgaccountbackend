import pool from '../config/db.js';
import permissionModel from '../models/Permission.model.js';
import { SIGN_TARGETS } from '../controllers/signature.controller.js';
import { canUserViewEntry, resolveEntryVisibility } from './entryVisibility.service.js';
import { durableExpenseDocumentUrl, signExpenseDocumentUrl } from '../utils/expenseDocumentUrls.js';
const inherited = Object.fromEntries(Object.entries(SIGN_TARGETS).filter(([key]) => !['commission_payment', 'registry_payment', 'cashflow_entry'].includes(key)));
export const DOCUMENTATION_TARGETS = Object.freeze({
  ...inherited,
  cash_flow_entry: SIGN_TARGETS.cashflow_entry,
  plot_commission_payment: SIGN_TARGETS.commission_payment,
  plot_registry_payment: SIGN_TARGETS.registry_payment,
  plot_commission: {
    table: 'plot_commissions',
    perm: 'commissions'
  },
  misc_income_entry: {
    table: 'misc_income_entries',
    perm: 'misc_income'
  },
  plot_installment_payment: {
    table: 'plot_installment_payments',
    perm: 'plot_payments',
    siteExpression: 'p.site_id',
    join: 'JOIN plots p ON p.id=t.plot_id'
  }
});
const ALIASES = {
  expenses: 'expense',
  cashflow_entry: 'cash_flow_entry',
  cashflow: 'cash_flow_entry',
  personal_ledger: 'cash_flow_entry',
  commission_payment: 'plot_commission_payment',
  registry_payment: 'plot_registry_payment',
  misc_income: 'misc_income_entry'
};
export const documentationSource = value => String(value || '').startsWith('daybook_') ? 'daybook' : ALIASES[value] || value;
export const documentationSourceForTable = table => Object.keys(DOCUMENTATION_TARGETS).find(key => DOCUMENTATION_TARGETS[key].table === table);
export const documentationError = (message, statusCode = 400, code = 'INVALID_DOCUMENTATION') => Object.assign(new Error(message), {
  statusCode,
  code
});
export function documentationId(value) {
  if (!/^\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value)) || Number(value) < 1) throw documentationError('Choose a valid transaction.');
  return Number(value);
}
const admin = user => ['admin', 'super_admin'].includes(user?.role);
const safeUrl = url => typeof url === 'string' && /^(https?:\/\/[^\s]+|\/uploads\/[^\s]+)$/.test(url) && url.length <= 4000;
export function validateDocumentationDraft(body = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw documentationError('Invalid documentation settings.');
  for (const key of ['bill_required', 'voucher_required']) if (body[key] !== undefined && typeof body[key] !== 'boolean' && body[key] !== null) throw documentationError(`${key} must be Yes, No, or null to use the site default.`);
  const version = body.version ?? body.expected_version ?? 0;
  if (!Number.isSafeInteger(version) || version < 0) throw documentationError('Supply a valid documentation version.');
  if (body.reason !== undefined && (typeof body.reason !== 'string' || body.reason.length > 1000)) throw documentationError('The documentation reason must be at most 1,000 characters.');
  let documents = body.documents;
  if (documents === undefined && (body.bill_urls !== undefined || body.voucher_urls !== undefined)) {
    if (![body.bill_urls ?? [], body.voucher_urls ?? []].every(Array.isArray)) throw documentationError('Document URLs must be arrays.');
    documents = [...(body.bill_urls || []).map(url => ({
      kind: 'bill',
      url
    })), ...(body.voucher_urls || []).map(url => ({
      kind: 'voucher',
      url
    }))];
  }
  if (documents !== undefined) {
    if (!Array.isArray(documents) || documents.length > 50) throw documentationError('Attach at most 50 documents.');
    documents = documents.filter(doc => doc?.origin !== 'legacy').map(doc => {
      if (!doc || !['bill', 'voucher'].includes(doc.kind) || !safeUrl(doc.url)) throw documentationError('Choose a valid uploaded bill or voucher URL.');
      return {
        kind: doc.kind,
        url: durableExpenseDocumentUrl(doc.url),
        name: String(doc.name || '').slice(0, 255)
      };
    });
    documents = [...new Map(documents.map(doc => [`${doc.kind}:${doc.url}`, doc])).values()];
  }
  return {
    ...body,
    version,
    ...(documents === undefined ? {} : {
      documents
    })
  };
}
export async function documentationPermission(user, source, action = 'read') {
  const target = DOCUMENTATION_TARGETS[documentationSource(source)];
  if (!target || !admin(user) && target.adminOnly) return false;
  if (admin(user)) return true;
  if (user?.role !== 'sub_admin') return false;
  const cache = user.permissionsByModule;
  const permission = cache instanceof Map && cache.has(target.perm) ? cache.get(target.perm) : await permissionModel.getPermission(user.id, target.perm);
  if (cache instanceof Map) cache.set(target.perm, permission);
  return permission?.[`can_${action}`] === true;
}
export async function documentationRecord(user, rawSource, rawId, database = pool, action = 'read') {
  const source = documentationSource(rawSource),
    target = DOCUMENTATION_TARGETS[source],
    id = documentationId(rawId);
  if (!target) throw documentationError('Unsupported transaction source.');
  if (!(await documentationPermission(user, source, action))) throw documentationError('You do not have permission to manage documentation in this module.', 403);
  const site = source === 'farmer_payment' ? 'f.site_id' : target.siteExpression || 't.site_id';
  const join = source === 'farmer_payment' ? 'JOIN farmers f ON f.id=t.farmer_id' : target.join || '';
  const {
    rows
  } = await database.query(`SELECT to_jsonb(t) AS record,${site} AS site_id FROM ${target.table} t ${join}
    JOIN sites s ON s.id=${site} WHERE t.id=$1 AND s.organization_id=$2`, [id, Number(user.organization_id) || 1]);
  const result = rows[0];
  if (!result) throw documentationError('Transaction not found.', 404);
  if (!admin(user)) {
    const membership = await database.query('SELECT 1 FROM user_sites WHERE user_id=$1 AND site_id=$2', [user.id, result.site_id]);
    if (!membership.rows.length || !(await canUserViewEntry(user, target.perm, result.record.created_by))) throw documentationError('Access denied to this transaction.', 403);
  }
  return {
    source,
    id,
    ...result
  };
}
export function presentDocumentation(state, canEdit = false) {
  const {
    sidecar_documents = [],
    legacy_bill_urls = [],
    legacy_voucher_urls = [],
    ...rest
  } = state;
  const documents = [...legacy_bill_urls.map(url => ({
    kind: 'bill',
    url,
    origin: 'legacy'
  })), ...legacy_voucher_urls.map(url => ({
    kind: 'voucher',
    url,
    origin: 'legacy'
  })), ...sidecar_documents.map(doc => ({
    ...doc,
    origin: 'documentation'
  }))];
  return {
    ...rest,
    can_edit: canEdit,
    documents: [...new Map(documents.map(doc => [`${doc.origin}:${doc.kind}:${doc.url}`, doc])).values()]
  };
}
export async function readDocumentation(reference, user, database = pool, {
  history = false
} = {}) {
  const {
    source,
    id,
    site_id,
    record
  } = reference;
  const {
    rows
  } = await database.query('SELECT transaction_documentation_state($1,$2,$3,$4::jsonb) AS documentation', [source, id, site_id, JSON.stringify(record)]);
  const result = presentDocumentation(rows[0].documentation, await documentationPermission(user, source, 'update'));
  if (history) result.history = (await database.query(`SELECT id,actor_id,actor_name,created_at,reason,changes,event_type
    FROM transaction_documentation_history WHERE source=$1 AND site_id=$3
    AND (record_id=$2 OR (record_id IS NULL AND transaction_type IN ('*',$4))) ORDER BY id DESC LIMIT 100`, [source, id, site_id, result.transaction_type])).rows;
  if (history) result.documents = await Promise.all(result.documents.map(async document => ({
    ...document,
    view_url: await signExpenseDocumentUrl(document.url)
  })));
  return result;
}

// Caller owns the transaction, including initial metadata on financial creation.
export async function saveDocumentation(user, source, id, body, database = pool, {
  creation = false
} = {}) {
  const draft = validateDocumentationDraft(body);
  const reference = await documentationRecord(user, source, id, database, creation ? 'write' : 'update');
  await database.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`transaction-documentation:${reference.source}:${reference.id}`]);
  await database.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`documentation-policy:${reference.site_id}:${reference.source}`]);
  // Lock the selected policy through commit, so a concurrent mandatory-policy
  // change cannot race an override. Policies are sparse; absent means baseline.
  await database.query('SELECT 1 FROM transaction_documentation_policies WHERE site_id=$1 AND source=$2 FOR SHARE', [reference.site_id, reference.source]);
  const before = await readDocumentation(reference, user, database);
  if (before.version !== draft.version) throw documentationError('Documentation changed in another session. Reload and review the latest settings.', 409, 'DOCUMENTATION_CONFLICT');
  for (const kind of ['bill', 'voucher']) if (before.locked[kind] && draft[`${kind}_required`] === false) throw documentationError(`${kind === 'bill' ? 'Bill' : 'Voucher'} documentation is mandatory under this site policy.`, 409, 'DOCUMENTATION_POLICY_LOCKED');
  const original = (await database.query('SELECT * FROM transaction_documentation WHERE source=$1 AND record_id=$2', [reference.source, reference.id])).rows[0] || {};
  const next = {
    bill_required: draft.bill_required === undefined ? original.bill_required ?? null : draft.bill_required,
    voucher_required: draft.voucher_required === undefined ? original.voucher_required ?? null : draft.voucher_required,
    reason: draft.reason === undefined ? original.reason || '' : draft.reason.trim(),
    documents: draft.documents === undefined ? original.documents || [] : draft.documents
  };
  await database.query(`INSERT INTO transaction_documentation(source,record_id,site_id,bill_required,voucher_required,reason,documents,version,updated_by)
    VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,1,$8) ON CONFLICT(source,record_id) DO UPDATE SET
    site_id=EXCLUDED.site_id,bill_required=EXCLUDED.bill_required,voucher_required=EXCLUDED.voucher_required,reason=EXCLUDED.reason,
    documents=EXCLUDED.documents,version=transaction_documentation.version+1,updated_by=EXCLUDED.updated_by,updated_at=now()`, [reference.source, reference.id, reference.site_id, next.bill_required, next.voucher_required, next.reason, JSON.stringify(next.documents), user.id]);
  const after = await readDocumentation(reference, user, database);
  await database.query(`INSERT INTO transaction_documentation_history(site_id,source,record_id,actor_id,actor_name,reason,changes)
    VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)`, [reference.site_id, reference.source, reference.id, user.id, user.name || null, next.reason, JSON.stringify({
    before: {
      bill_required: before.bill_required,
      voucher_required: before.voucher_required,
      documents: before.documents,
      version: before.version
    },
    after: {
      ...next,
      version: after.version
    }
  })]);
  return readDocumentation(reference, user, database, {
    history: true
  });
}

// An accounting mirror always follows its native transaction's saved rules.
const MIRROR_OWNER_FIELDS = [['expense_id', 'expense'], ['farmer_payment_id', 'farmer_payment'], ['commission_id', 'plot_commission'], ['commission_payment_id', 'plot_commission_payment'], ['cash_flow_entry_id', 'cash_flow_entry'], ['firm_transaction_id', 'firm_transaction'], ['plot_payment_id', 'plot_payment'], ['vendor_payment_id', 'vendor_payment']];
function documentationOwner(row) {
  const source = documentationSource(row.source);
  if (source === 'daybook') {
    const owner = MIRROR_OWNER_FIELDS.find(([field]) => Number(row[field]) > 0);
    if (owner) return {
      source: owner[1],
      record_id: Number(row[owner[0]]),
      site_id: Number(row.site_id)
    };
  }
  return {
    source,
    record_id: Number(row.id),
    site_id: Number(row.site_id)
  };
}

// Approval rows already passed workspace authorization. One grouped SQL query
// loads native row evidence and saved requirements for every admitted entry.
export async function enrichTransactionDocumentation(entries, user, database = pool) {
  const refs = [...new Map(entries.map(documentationOwner).filter(ref => DOCUMENTATION_TARGETS[ref.source] && ref.site_id > 0).map(ref => [`${ref.source}:${ref.record_id}:${ref.site_id}`, ref])).values()];
  if (!refs.length) return entries;
  const fragments = [...new Set(refs.map(ref => ref.source))].map(source => {
    const target = DOCUMENTATION_TARGETS[source];
    const site = source === 'farmer_payment' ? 'f.site_id' : target.siteExpression || 't.site_id';
    const join = source === 'farmer_payment' ? 'JOIN farmers f ON f.id=t.farmer_id' : target.join || '';
    return `SELECT '${source}' AS source,t.id AS record_id,
      transaction_documentation_state('${source}',t.id,${site},to_jsonb(t)) AS documentation
      FROM ${target.table} t ${join} JOIN sites s ON s.id=${site} AND s.organization_id=$2
      JOIN requested r ON r.source='${source}' AND r.record_id=t.id AND r.site_id=${site}`;
  });
  const {
    rows
  } = await database.query(`WITH requested AS (
    SELECT * FROM jsonb_to_recordset($1::jsonb) AS r(source text,record_id bigint,site_id integer)
  ) ${fragments.join(' UNION ALL ')}`, [JSON.stringify(refs), Number(user.organization_id) || 1]);
  const permissions = new Map(await Promise.all([...new Set(refs.map(ref => ref.source))].map(async source => [source, await documentationPermission(user, source, 'update')])));
  const states = new Map(rows.map(row => [`${row.source}:${row.record_id}`, presentDocumentation(row.documentation, permissions.get(row.source))]));
  for (const entry of entries) {
    const owner = documentationOwner(entry);
    const documentation = states.get(`${owner.source}:${owner.record_id}`);
    if (documentation) entry.documentation = documentation;
  }
  return entries;
}
export async function readDocumentationBatch(user, records, database = pool) {
  const refs = [...new Map(records.map(item => {
    const source = documentationSource(item.source),
      id = documentationId(item.id);
    if (!DOCUMENTATION_TARGETS[source]) throw documentationError('Unsupported transaction source.');
    return [`${source}:${id}`, {
      source,
      id
    }];
  })).values()];
  const fragments = [],
    permissions = new Map();
  for (const source of [...new Set(refs.map(item => item.source))]) {
    if (!(await documentationPermission(user, source))) continue;
    const target = DOCUMENTATION_TARGETS[source],
      site = source === 'farmer_payment' ? 'f.site_id' : target.siteExpression || 't.site_id';
    const join = source === 'farmer_payment' ? 'JOIN farmers f ON f.id=t.farmer_id' : target.join || '';
    const conditions = ['s.organization_id=$1'];
    if (!admin(user)) {
      conditions.push(`EXISTS(SELECT 1 FROM user_sites us WHERE us.site_id=${site} AND us.user_id=${Number(user.id)})`);
      const visibility = await resolveEntryVisibility(user, target.perm, null);
      if (!visibility.canViewAll) conditions.push(`(to_jsonb(t)->>'created_by')::bigint=${Number(user.id)}`);
    }
    permissions.set(source, await documentationPermission(user, source, 'update'));
    fragments.push(`SELECT '${source}' AS source,t.id,transaction_documentation_state('${source}',t.id,${site},to_jsonb(t)) AS documentation
      FROM ${target.table} t ${join} JOIN sites s ON s.id=${site}
      JOIN requested r ON r.source='${source}' AND r.id=t.id WHERE ${conditions.join(' AND ')}`);
  }
  if (!fragments.length) return {};
  const {
    rows
  } = await database.query(`WITH requested AS(SELECT * FROM jsonb_to_recordset($2::jsonb) AS r(source text,id bigint)) ${fragments.join(' UNION ALL ')}`, [Number(user.organization_id) || 1, JSON.stringify(refs)]);
  return Object.fromEntries(rows.map(row => [`${row.source}:${row.id}`, presentDocumentation(row.documentation, permissions.get(row.source))]));
}
export async function listDocumentationGaps(user, filters = {}, database = pool) {
  const params = [Number(user.organization_id) || 1],
    fragments = [];
  if (filters.site_id) params.push(documentationId(filters.site_id));
  for (const [source, target] of Object.entries(DOCUMENTATION_TARGETS)) {
    if (!(await documentationPermission(user, source))) continue;
    const site = source === 'farmer_payment' ? 'f.site_id' : target.siteExpression || 't.site_id';
    const join = source === 'farmer_payment' ? 'JOIN farmers f ON f.id=t.farmer_id' : target.join || '';
    const conditions = [`s.organization_id=$1`];
    if (filters.site_id) conditions.push(`${site}=$2`);
    if (!admin(user)) {
      conditions.push(`EXISTS(SELECT 1 FROM user_sites us WHERE us.site_id=${site} AND us.user_id=${Number(user.id)})`);
      const visibility = await resolveEntryVisibility(user, target.perm, null);
      if (!visibility.canViewAll) conditions.push(`(to_jsonb(t)->>'created_by')::bigint=${Number(user.id)}`);
    }
    // Exclude accounting mirrors. Their native row is the documentation owner.
    if (source === 'cash_flow_entry') conditions.push(`NULLIF(to_jsonb(t)->>'source_module','') IS NULL`);
    if (source === 'plot_registry_payment') conditions.push(`NULLIF(to_jsonb(t)->>'source_plot_payment_id','') IS NULL`);
    if (source === 'vendor_inventory_payment') conditions.push(`NULLIF(to_jsonb(t)->>'source_vendor_payment_id','') IS NULL`);
    if (source === 'firm_transaction') conditions.push(`NOT (COALESCE(to_jsonb(t)->>'is_firm_to_firm_transfer','false')='true' AND COALESCE(to_jsonb(t)->>'transfer_direction','')='IN')`);
    if (source === 'daybook') for (const field of ['expense_id', 'farmer_payment_id', 'commission_id', 'cash_flow_entry_id', 'firm_transaction_id', 'plot_payment_id', 'vendor_payment_id', 'registry_payment_id', 'vendor_inventory_payment_id', 'misc_income_entry_id', 'land_deal_payment_id']) conditions.push(`NULLIF(to_jsonb(t)->>'${field}','') IS NULL`);
    fragments.push(`SELECT '${source}'::text AS source,t.id::bigint,${site} AS site_id,s.name AS site_name,to_jsonb(t) AS record FROM ${target.table} t ${join} JOIN sites s ON s.id=${site} WHERE ${conditions.join(' AND ')}`);
  }
  if (!fragments.length) return [];
  const where = [`COALESCE(record->>'status','approved') IN ('pending','approved','waiting')`];
  for (const [key, op] of [['date_from', '>='], ['date_to', '<=']]) if (filters[key]) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(filters[key])) throw documentationError('Choose a valid date.');
    params.push(filters[key]);
    where.push(`COALESCE(record->>'date',record->>'payment_date') ${op} $${params.length}`);
  }
  // A conservative candidate gate skips reviewed/complete legacy records
  // before the full engine runs. Explicit requirements and applicable policy
  // always enter the engine, which alone decides the final saved status.
  const candidate = `(
    EXISTS (SELECT 1 FROM transaction_documentation d WHERE d.source=r.source AND d.record_id=r.id AND d.site_id=r.site_id
      AND (d.bill_required OR d.voucher_required))
    OR EXISTS (SELECT 1 FROM transaction_documentation_policies p WHERE p.source=r.source AND p.site_id=r.site_id
      AND p.transaction_type IN ('*',transaction_documentation_type(record))
      AND (p.bill_required OR p.voucher_required OR p.bill_locked OR p.voucher_locked))
    OR (source='expense' AND transaction_documentation_mode(record)<>'CASH'
      AND transaction_documentation_urls(record,'bill')='[]'::jsonb)
    OR (transaction_documentation_mode(record)='CASH' AND record->>'voucher_gap_filled_at' IS NULL
      AND transaction_documentation_urls(record,'voucher')='[]'::jsonb)
  )`;
  const {
    rows
  } = await database.query(`WITH records AS MATERIALIZED(${fragments.join(' UNION ALL ')}),states AS MATERIALIZED(
    SELECT *,transaction_documentation_state(source,id,site_id,record) AS documentation FROM records r
    WHERE ${where.join(' AND ')} AND ${candidate})
    SELECT * FROM states WHERE documentation->>'missing_bill'='true' OR documentation->>'missing_voucher'='true'
    ORDER BY COALESCE(record->>'date',record->>'payment_date') DESC,id DESC`, params);
  return rows.map(({
    record,
    documentation,
    ...row
  }) => ({
    ...record,
    ...row,
    date: record.date || record.payment_date,
    amount: record.amount || Math.max(Number(record.debit) || 0, Number(record.credit) || 0),
    entity_name: record.party_name || record.to_entity || record.from_entity || record.name || record.particular || record.description || '',
    module_label: row.source.replaceAll('_', ' '),
    documentation: presentDocumentation(documentation, admin(user) || user.permissionsByModule?.get(DOCUMENTATION_TARGETS[row.source].perm)?.can_update === true)
  }));
}
