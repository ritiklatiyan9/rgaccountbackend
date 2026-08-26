import pool from '../config/db.js';
import asyncHandler from '../utils/asyncHandler.js';

const positiveInt = (value, fallback) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

const addFilter = (params, where, value, sql) => {
  if (value == null || value === '') return;
  params.push(value);
  where.push(sql.replace('?', `$${params.length}`));
};

const findNestedAuditValue = (value, keys, depth = 0) => {
  if (value == null || depth > 5) return null;
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 20)) {
      const found = findNestedAuditValue(item, keys, depth + 1);
      if (found != null) return found;
    }
    return null;
  }
  if (typeof value !== 'object') return null;
  for (const key of keys) {
    const matchingKey = Object.keys(value).find((candidate) => candidate.toLowerCase() === key);
    if (matchingKey && value[matchingKey] != null && value[matchingKey] !== '') return value[matchingKey];
  }
  for (const item of Object.values(value)) {
    const found = findNestedAuditValue(item, keys, depth + 1);
    if (found != null) return found;
  }
  return null;
};

const legacyAmountFromSnapshot = (snapshot) => {
  const keys = ['amount', 'total_amount', 'paid_amount', 'payment_amount', 'debit', 'credit', 'value'];
  for (const key of keys) {
    const value = findNestedAuditValue(snapshot, [key]);
    const amount = Number(value);
    if (value != null && Number.isFinite(amount) && Math.abs(amount) > 0 && Math.abs(amount) < 1e15) return Math.abs(amount);
  }
  return null;
};

const legacyTransactionNameFromSnapshot = (snapshot) => {
  const keys = [
    'transaction_name', 'expense_name', 'particular', 'description', 'remark', 'reason',
    'title', 'plot_no', 'payment_from', 'narration', 'to_entity', 'from_entity',
    'entity_name', 'name', 'category',
  ];
  const value = findNestedAuditValue(snapshot, keys);
  if (value == null || typeof value === 'object') return null;
  const name = String(value).trim();
  return name ? name.slice(0, 500) : null;
};

const enrichLegacyAuditRows = (rows) => rows.map((row) => ({
  ...row,
  amount: row.amount == null ? legacyAmountFromSnapshot(row.new_values) : row.amount,
  transaction_name: row.transaction_name || legacyTransactionNameFromSnapshot(row.new_values),
}));

const buildScope = (req) => {
  const params = [Number(req.user.organization_id) || 1];
  const where = ['a.organization_id = $1'];
  if (req.user.role === 'sub_admin') {
    params.push(Number(req.user.id));
    where.push(`(
      a.user_id = $${params.length}
      OR a.site_id IN (SELECT site_id FROM user_sites WHERE user_id = $${params.length})
    )`);
  }
  return { params, where };
};

export const listAuditLogs = asyncHandler(async (req, res) => {
  const page = positiveInt(req.query.page, 1);
  // Audit review intentionally defaults to 100 and is capped at 100 so one
  // request remains predictable even when the history grows into millions.
  const limit = Math.min(100, positiveInt(req.query.limit, 100));
  const offset = (page - 1) * limit;
  const { params, where } = buildScope(req);

  addFilter(params, where, req.query.user_id ? positiveInt(req.query.user_id, null) : null, 'a.user_id = ?');
  addFilter(params, where, req.query.site_id ? positiveInt(req.query.site_id, null) : null, 'a.site_id = ?');
  addFilter(params, where, req.query.action ? String(req.query.action).toUpperCase() : null, 'a.action = ?');
  addFilter(params, where, req.query.module ? String(req.query.module).toLowerCase() : null, 'LOWER(a.module) = ?');
  addFilter(params, where, req.query.outcome ? String(req.query.outcome).toUpperCase() : null, 'a.outcome = ?');
  addFilter(params, where, req.query.date_from, 'a.created_at >= ?::date');
  addFilter(params, where, req.query.date_to, `a.created_at < (?::date + INTERVAL '1 day')`);

  const search = String(req.query.search || '').trim();
  if (search) {
    params.push(`%${search}%`);
    const p = `$${params.length}`;
    where.push(`(
      a.description ILIKE ${p}
      OR a.module ILIKE ${p}
      OR a.entity_type ILIKE ${p}
      OR a.entity_id ILIKE ${p}
      OR u.name ILIKE ${p}
      OR u.email ILIKE ${p}
      OR s.name ILIKE ${p}
    )`);
  }

  const fromSql = `
    FROM audit_logs a
    LEFT JOIN users u ON u.id = a.user_id
    LEFT JOIN sites s ON s.id = a.site_id
    WHERE ${where.join(' AND ')}
  `;
  const baseParams = [...params];

  const listParams = [...baseParams, limit, offset];
  const [logsResult, summaryResult] = await Promise.all([
    pool.query(
      `SELECT
         a.*,
         COALESCE(u.name, CASE WHEN a.user_id IS NULL THEN 'System' ELSE 'Deleted user #' || a.user_id END) AS user_name,
         u.email AS user_email,
         u.photo AS user_photo,
         u.role AS user_role,
         s.name AS site_name
       ${fromSql}
       ORDER BY a.created_at DESC, a.id DESC
       LIMIT $${listParams.length - 1} OFFSET $${listParams.length}`,
      listParams
    ),
    pool.query(
      `SELECT
         COUNT(*)::int AS total,
         COUNT(*) FILTER (WHERE a.created_at >= CURRENT_DATE)::int AS today,
         COUNT(*) FILTER (WHERE a.outcome = 'FAILURE')::int AS failures,
         COUNT(DISTINCT a.user_id)::int AS unique_users,
         COUNT(*) FILTER (WHERE a.action = 'CREATE')::int AS creates,
         COUNT(*) FILTER (WHERE a.action = 'UPDATE')::int AS updates,
         COUNT(*) FILTER (WHERE a.action = 'DELETE')::int AS deletes
       ${fromSql}`,
      baseParams
    ),
  ]);

  // Filter choices use the user's whole visible audit scope rather than the
  // current filters, so a selection never removes itself from the dropdown.
  const scope = buildScope(req);
  const scopeWhere = scope.where.join(' AND ');
  const [actorsResult, modulesResult, actionsResult] = await Promise.all([
    pool.query(
      `SELECT DISTINCT u.id, u.name, u.email, u.photo, u.role
         FROM audit_logs a JOIN users u ON u.id = a.user_id
        WHERE ${scopeWhere}
        ORDER BY u.name`,
      scope.params
    ),
    pool.query(
      `SELECT DISTINCT a.module FROM audit_logs a WHERE ${scopeWhere} ORDER BY a.module`,
      scope.params
    ),
    pool.query(
      `SELECT DISTINCT a.action FROM audit_logs a WHERE ${scopeWhere} ORDER BY a.action`,
      scope.params
    ),
  ]);

  const summary = summaryResult.rows[0] || {};
  const total = Number(summary.total) || 0;
  res.json({
    logs: enrichLegacyAuditRows(logsResult.rows),
    summary: {
      total,
      today: Number(summary.today) || 0,
      failures: Number(summary.failures) || 0,
      unique_users: Number(summary.unique_users) || 0,
      creates: Number(summary.creates) || 0,
      updates: Number(summary.updates) || 0,
      deletes: Number(summary.deletes) || 0,
    },
    filters: {
      users: actorsResult.rows,
      modules: modulesResult.rows.map((row) => row.module),
      actions: actionsResult.rows.map((row) => row.action),
    },
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    },
  });
});
