import pool from '../config/db.js';
import asyncHandler from '../utils/asyncHandler.js';
import { deletePlotDoc } from '../utils/plotDocStorage.js';
import { deleteFromS3 } from '../utils/s3.js';

const PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;
const MAX_DETAIL_ROWS = 250;

const PREVIEW_KEYS = new Set([
  'id', 'date', 'name', 'full_name', 'title', 'plot_no', 'booking_no', 'deal_no',
  'document_name', 'original_name', 'vendor_name', 'customer_name', 'buyer_name',
  'particular', 'description', 'remark', 'notes', 'category', 'status', 'payment_mode',
  'amount', 'debit', 'credit', 'total_amount', 'sale_amount', 'contract_amount',
  'created_at', 'updated_at', 'due_date', 'payment_date', 'entry_type', 'direction',
]);

const positiveInt = (value, fallback) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

const parseBatchId = (value) => {
  const normalized = String(value || '').trim();
  return /^\d{1,20}$/.test(normalized) ? normalized : null;
};

const publicSnapshot = (rowData) => Object.fromEntries(
  Object.entries(rowData || {}).filter(([key, value]) => (
    PREVIEW_KEYS.has(key) && value != null && value !== '' && typeof value !== 'object'
  ))
);

const isOrgAdmin = (user) => user?.role === 'admin' || user?.role === 'super_admin';

const batchListSql = `
  WITH base AS (
    SELECT *
      FROM recycle_bin_entries
     WHERE organization_id = $1
       AND (($4 = 'active' AND restored_at IS NULL)
         OR ($4 = 'restored' AND restored_at IS NOT NULL))
  ), grouped AS (
    SELECT
      deletion_batch,
      MIN(id) AS first_entry_id,
      COUNT(*)::int AS record_count,
      COUNT(DISTINCT source_table)::int AS table_count,
      (array_agg(display_name ORDER BY id))[1] AS display_name,
      (array_agg(record_id ORDER BY id) FILTER (WHERE record_id IS NOT NULL))[1] AS record_id,
      (array_agg(source_table ORDER BY id))[1] AS primary_table,
      (array_agg(source_module ORDER BY id))[1] AS primary_module,
      array_agg(DISTINCT source_module ORDER BY source_module) AS source_modules,
      array_agg(DISTINCT source_table ORDER BY source_table) AS source_tables,
      array_agg(DISTINCT site_id ORDER BY site_id) FILTER (WHERE site_id IS NOT NULL) AS site_ids,
      MIN(deleted_at) AS deleted_at,
      MAX(restored_at) AS restored_at,
      (array_agg(deleted_by ORDER BY id) FILTER (WHERE deleted_by IS NOT NULL))[1] AS deleted_by,
      (array_agg(restored_by ORDER BY id) FILTER (WHERE restored_by IS NOT NULL))[1] AS restored_by,
      bool_or(delete_kind = 'SOFT') AS includes_soft_delete,
      string_agg(COALESCE(display_name, '') || ' ' || COALESCE(record_id, '') || ' ' || source_table || ' ' || source_module, ' ') AS search_text
    FROM base
    GROUP BY deletion_batch
  ), visible AS (
    SELECT * FROM grouped g
     WHERE (
       $3::boolean
       OR (
         COALESCE(cardinality(g.site_ids), 0) > 0
         AND NOT EXISTS (
           SELECT 1 FROM unnest(g.site_ids) AS scoped_site(site_id)
            WHERE NOT EXISTS (
              SELECT 1 FROM user_sites us
               WHERE us.user_id = $2 AND us.site_id = scoped_site.site_id
            )
         )
       )
     )
       AND ($5::integer IS NULL OR $5 = ANY(g.site_ids) OR ($3::boolean AND COALESCE(cardinality(g.site_ids), 0) = 0))
       AND ($6::text IS NULL OR $6 = ANY(g.source_modules))
       AND ($7::text IS NULL OR g.search_text ILIKE '%' || $7 || '%')
  )
`;

const listParams = (req, status, limit, offset) => [
  Number(req.user.organization_id) || 1,
  Number(req.user.id),
  isOrgAdmin(req.user),
  status,
  req.query.site_id ? positiveInt(req.query.site_id, null) : null,
  req.query.module ? String(req.query.module).trim().toLowerCase() || null : null,
  req.query.search ? String(req.query.search).trim().slice(0, 200) || null : null,
  limit,
  offset,
];

export const listRecycleBin = asyncHandler(async (req, res) => {
  const page = positiveInt(req.query.page, 1);
  const limit = Math.min(MAX_PAGE_SIZE, positiveInt(req.query.limit, PAGE_SIZE));
  const offset = (page - 1) * limit;
  const status = req.query.status === 'restored' ? 'restored' : 'active';
  const params = listParams(req, status, limit, offset);

  const [itemsResult, countResult, summaryResult] = await Promise.all([
    pool.query(
      `${batchListSql}
       SELECT v.*,
              COALESCE(v.deleted_by, inferred_deleter.user_id) AS effective_deleted_by,
              deleter.name AS deleted_by_name,
              CASE WHEN v.deleted_by IS NOT NULL THEN 'recorded' WHEN inferred_deleter.user_id IS NOT NULL THEN 'audit' ELSE 'unknown' END AS deleted_by_source,
              restorer.name AS restored_by_name,
              COALESCE(
                (SELECT string_agg(s.name, ', ' ORDER BY s.name) FROM sites s WHERE s.id = ANY(v.site_ids)),
                CASE WHEN COALESCE(cardinality(v.site_ids), 0) = 0 THEN 'Organisation-wide' ELSE 'Deleted site' END
              ) AS site_name
         FROM visible v
         LEFT JOIN LATERAL (
           SELECT a.user_id
             FROM audit_logs a
            WHERE v.deleted_by IS NULL
              AND a.organization_id = $1
              AND a.action = 'DELETE'
              AND a.outcome = 'SUCCESS'
              AND a.created_at BETWEEN v.deleted_at - INTERVAL '5 seconds' AND v.deleted_at + INTERVAL '90 seconds'
              AND (a.entity_id = v.record_id OR a.module = v.primary_module)
            ORDER BY (a.entity_id = v.record_id) DESC,
                     ABS(EXTRACT(EPOCH FROM (a.created_at - v.deleted_at))) ASC
            LIMIT 1
         ) inferred_deleter ON TRUE
         LEFT JOIN users deleter ON deleter.id = COALESCE(v.deleted_by, inferred_deleter.user_id)
         LEFT JOIN users restorer ON restorer.id = v.restored_by
        ORDER BY CASE WHEN $4 = 'active' THEN v.deleted_at ELSE v.restored_at END DESC, v.deletion_batch DESC
        LIMIT $8 OFFSET $9`,
      params
    ),
    pool.query(`${batchListSql} SELECT COUNT(*)::int AS total FROM visible`, params.slice(0, 7)),
    pool.query(
      `WITH grouped AS (
         SELECT deletion_batch,
                bool_and(restored_at IS NOT NULL) AS restored,
                COUNT(*)::int AS records,
                MAX(restored_at) AS restored_at,
                array_agg(DISTINCT site_id) FILTER (WHERE site_id IS NOT NULL) AS site_ids
           FROM recycle_bin_entries
          WHERE organization_id = $1
          GROUP BY deletion_batch
       ), visible AS (
         SELECT * FROM grouped g
          WHERE ($3::boolean OR (
            COALESCE(cardinality(g.site_ids), 0) > 0
            AND NOT EXISTS (
              SELECT 1 FROM unnest(g.site_ids) AS scoped_site(site_id)
               WHERE NOT EXISTS (SELECT 1 FROM user_sites us WHERE us.user_id=$2 AND us.site_id=scoped_site.site_id)
            )
          ))
          AND ($4::integer IS NULL OR $4 = ANY(g.site_ids) OR ($3::boolean AND COALESCE(cardinality(g.site_ids), 0) = 0))
       )
       SELECT
         COUNT(*) FILTER (WHERE NOT restored)::int AS active_batches,
         COALESCE(SUM(records) FILTER (WHERE NOT restored), 0)::int AS active_records,
         COUNT(*) FILTER (WHERE restored)::int AS restored_batches,
         COUNT(*) FILTER (WHERE restored AND restored_at >= CURRENT_DATE)::int AS restored_today
       FROM visible`,
      [params[0], params[1], params[2], params[4]]
    ),
  ]);

  const total = Number(countResult.rows[0]?.total) || 0;
  const modules = [...new Set(itemsResult.rows.flatMap((row) => row.source_modules || []))].sort();
  res.json({
    items: itemsResult.rows,
    summary: summaryResult.rows[0] || {},
    filters: { modules },
    pagination: {
      page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)),
    },
  });
});

async function lockAndAuthorizeBatch(db, req, batchId, { requireActive = false } = {}) {
  const result = await db.query(
    `SELECT id, organization_id, site_id, restored_at
       FROM recycle_bin_entries
      WHERE deletion_batch = $1
      ORDER BY id
      FOR UPDATE`,
    [batchId]
  );
  if (!result.rows.length) return { status: 404, message: 'Recycle-bin transaction not found' };
  const organizationId = Number(req.user.organization_id) || 1;
  if (result.rows.some((row) => Number(row.organization_id) !== organizationId)) {
    return { status: 404, message: 'Recycle-bin transaction not found' };
  }
  if (requireActive && result.rows.every((row) => row.restored_at)) {
    return { status: 409, message: 'This transaction has already been restored' };
  }
  if (!isOrgAdmin(req.user)) {
    const siteIds = [...new Set(result.rows.map((row) => Number(row.site_id)).filter(Number.isInteger))];
    if (!siteIds.length) return { status: 403, message: 'Organisation-wide recovery requires an administrator' };
    const allowed = await db.query(
      `SELECT site_id FROM user_sites WHERE user_id=$1 AND site_id=ANY($2::int[])`,
      [req.user.id, siteIds]
    );
    if (allowed.rowCount !== siteIds.length) return { status: 403, message: 'This deletion includes a site outside your access' };
  }
  return { rows: result.rows };
}

export const getRecycleBinBatch = asyncHandler(async (req, res) => {
  const batchId = parseBatchId(req.params.batchId);
  if (!batchId) return res.status(400).json({ message: 'Invalid recycle-bin transaction' });
  const access = await lockAndAuthorizeBatch(pool, req, batchId);
  if (!access.rows) return res.status(access.status).json({ message: access.message });

  const { rows } = await pool.query(
    `SELECT e.id, e.deletion_batch, e.source_module, e.source_table, e.record_id,
            e.display_name, e.delete_kind, e.deleted_at, e.restored_at,
            e.deleted_by, deleter.name AS deleted_by_name,
            e.row_data, e.site_id, s.name AS site_name
       FROM recycle_bin_entries e
       LEFT JOIN sites s ON s.id=e.site_id
       LEFT JOIN users deleter ON deleter.id=e.deleted_by
      WHERE e.deletion_batch=$1
      ORDER BY e.id
      LIMIT $2`,
    [batchId, MAX_DETAIL_ROWS]
  );
  res.json({
    batch_id: batchId,
    records: rows.map(({ row_data: rowData, ...row }) => ({ ...row, snapshot: publicSnapshot(rowData) })),
    truncated: access.rows.length > MAX_DETAIL_ROWS,
    total_records: access.rows.length,
  });
});

export const restoreRecycleBinBatch = asyncHandler(async (req, res) => {
  const batchId = parseBatchId(req.params.batchId);
  if (!batchId) return res.status(400).json({ message: 'Invalid recycle-bin transaction' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const access = await lockAndAuthorizeBatch(client, req, batchId, { requireActive: true });
    if (!access.rows) {
      await client.query('ROLLBACK');
      return res.status(access.status).json({ message: access.message });
    }
    const result = await client.query('SELECT restore_recycle_bin_batch($1, $2) AS restored_count', [batchId, req.user.id]);
    await client.query('COMMIT');
    const restoredCount = Number(result.rows[0]?.restored_count) || 0;
    res.json({
      message: `${restoredCount} record${restoredCount === 1 ? '' : 's'} restored successfully`,
      batch_id: batchId,
      restored_count: restoredCount,
      site_id: access.rows.find((row) => row.site_id)?.site_id || null,
    });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    const conflictCodes = new Set(['23503', '23505', '23502', '23514', 'P0002']);
    if (conflictCodes.has(error.code)) {
      return res.status(409).json({ message: error.message, code: 'RESTORE_CONFLICT' });
    }
    throw error;
  } finally {
    client.release();
  }
});

const archivedStorageTargets = (entries) => {
  const targets = [];
  for (const entry of entries) {
    const row = entry.row_data || {};
    if (entry.source_table === 'documents' && row.file_path) targets.push({ kind: 'plot-doc', key: row.file_path, table: 'documents', column: 'file_path' });
    if (entry.source_table === 'compliance_documents' && row.storage_key) targets.push({ kind: 'plot-doc', key: row.storage_key, table: 'compliance_documents', column: 'storage_key' });
    if (entry.source_table === 'document_imprest') {
      if (row.photo_key) targets.push({ kind: 'plot-doc', key: row.photo_key, table: 'document_imprest', column: 'photo_key' });
      if (row.return_photo_key) targets.push({ kind: 'plot-doc', key: row.return_photo_key, table: 'document_imprest', column: 'return_photo_key' });
    }
    if (entry.source_table === 'excel_files' && row.s3_key) targets.push({ kind: 's3', key: row.s3_key, table: 'excel_files', column: 's3_key' });
  }
  return [...new Map(targets.map((target) => [`${target.kind}:${target.key}`, target])).values()];
};

async function cleanupStorageTarget(target) {
  const table = `"${target.table.replaceAll('"', '""')}"`;
  const column = `"${target.column.replaceAll('"', '""')}"`;
  const stillUsed = await pool.query(
    `SELECT EXISTS (SELECT 1 FROM public.${table} WHERE ${column}=$1) AS active,
            EXISTS (
              SELECT 1 FROM recycle_bin_entries
               WHERE restored_at IS NULL AND row_data ->> $2 = $1
            ) AS archived`,
    [target.key, target.column]
  );
  if (stillUsed.rows[0]?.active || stillUsed.rows[0]?.archived) return false;
  if (target.kind === 's3') await deleteFromS3(target.key);
  else await deletePlotDoc(target.key);
  return true;
}

export const purgeRecycleBinBatch = asyncHandler(async (req, res) => {
  const batchId = parseBatchId(req.params.batchId);
  if (!batchId) return res.status(400).json({ message: 'Invalid recycle-bin transaction' });
  const client = await pool.connect();
  let archivedEntries = [];
  try {
    await client.query('BEGIN');
    const access = await lockAndAuthorizeBatch(client, req, batchId, { requireActive: true });
    if (!access.rows) {
      await client.query('ROLLBACK');
      return res.status(access.status).json({ message: access.message });
    }
    const entries = await client.query(
      `SELECT source_table, row_data FROM recycle_bin_entries WHERE deletion_batch=$1 AND restored_at IS NULL`,
      [batchId]
    );
    archivedEntries = entries.rows;
    const purged = await client.query('SELECT purge_recycle_bin_batch($1) AS purged_count', [batchId]);
    const purgedCount = Number(purged.rows[0]?.purged_count) || 0;
    await client.query('COMMIT');

    const targets = archivedStorageTargets(archivedEntries);
    const results = await Promise.allSettled(targets.map(cleanupStorageTarget));
    const cleanupWarnings = results.filter((result) => result.status === 'rejected').length;
    res.json({
      message: `${purgedCount} archived record${purgedCount === 1 ? '' : 's'} permanently deleted`,
      batch_id: batchId,
      purged_count: purgedCount,
      storage_cleanup_warnings: cleanupWarnings,
      site_id: access.rows.find((row) => row.site_id)?.site_id || null,
    });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
});
