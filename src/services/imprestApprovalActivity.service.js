// One site-scoped snapshot for both approval surfaces. Only sent history is
// capped; pending counts and amounts include every outstanding record.
export async function loadImprestApprovalActivity(db, {
  siteId, userId, isAdmin, canReadPersonal, canManage,
}) {
  const { rows } = await db.query(`
    WITH received AS (
      SELECT 'imprest'::text AS kind, to_jsonb(r) AS record, r.created_at,
             r.sub_admin_id AS requester_id, r.assigned_admin_id AS reviewer_id,
             r.amount AS debit, 0::numeric AS credit,
             ($3 OR ($4 AND r.assigned_admin_id = $2 AND r.sub_admin_id <> $2)) AS can_decide
        FROM imprest_expense_requests r
       WHERE r.site_id = $1 AND r.status = 'PENDING'
         AND ($5 OR ($4 AND r.assigned_admin_id = $2 AND r.sub_admin_id <> $2))
      UNION ALL
      SELECT 'imprest_return', to_jsonb(r), r.created_at, r.sub_admin_id,
             r.assigned_admin_id, 0::numeric, r.amount, $3
        FROM imprest_returns r
       WHERE r.site_id = $1 AND r.status = 'PENDING' AND $5
      UNION ALL
      SELECT 'allocation', to_jsonb(a), a.created_at, a.admin_id,
             a.assigned_admin_id, 0::numeric, a.amount, true
        FROM imprest_allocations a
       WHERE a.site_id = $1 AND a.status = 'PENDING_RECEIPT'
         AND a.sub_admin_id = $2 AND $4
    ), sent AS (
      (SELECT 'imprest'::text AS kind, to_jsonb(r) AS record, r.created_at,
              r.sub_admin_id AS requester_id, r.assigned_admin_id AS reviewer_id
         FROM imprest_expense_requests r
        WHERE r.site_id = $1 AND r.sub_admin_id = $2 AND $4
        ORDER BY r.created_at DESC, r.id DESC LIMIT 100)
      UNION ALL
      (SELECT 'imprest_return', to_jsonb(r), r.created_at, r.sub_admin_id, r.assigned_admin_id
         FROM imprest_returns r
        WHERE r.site_id = $1 AND r.sub_admin_id = $2 AND $4
        ORDER BY r.created_at DESC, r.id DESC LIMIT 100)
      UNION ALL
      (SELECT 'allocation', to_jsonb(a), a.created_at, a.admin_id, a.assigned_admin_id
         FROM imprest_allocations a
        WHERE a.site_id = $1 AND a.admin_id = $2 AND ($4 OR $3)
        ORDER BY a.created_at DESC, a.id DESC LIMIT 100)
    ), received_details AS (
      SELECT r.record || jsonb_build_object(
        '_type', r.kind, 'source', CASE WHEN r.kind = 'allocation' THEN 'imprest_allocation' ELSE r.kind END,
        'created_by_name', u.name, 'sub_admin_name', holder.name, 'admin_name', giver.name,
        'assigned_admin_name', reviewer.name, 'site_name', s.name,
        'date', r.created_at, 'debit', r.debit, 'credit', r.credit, 'can_decide', r.can_decide
      ) AS record, r.created_at
      FROM received r
      LEFT JOIN users u ON u.id = r.requester_id
      LEFT JOIN users holder ON holder.id = (r.record->>'sub_admin_id')::integer
      LEFT JOIN users giver ON giver.id = (r.record->>'admin_id')::integer
      LEFT JOIN users reviewer ON reviewer.id = r.reviewer_id
      LEFT JOIN sites s ON s.id = $1
    ), sent_details AS (
      SELECT r.record || jsonb_build_object(
        '_type', r.kind, 'source', CASE WHEN r.kind = 'allocation' THEN 'imprest_allocation' ELSE r.kind END,
        'created_by_name', u.name, 'sub_admin_name', holder.name, 'admin_name', giver.name,
        'assigned_admin_name', reviewer.name, 'site_name', s.name, 'can_decide', false
      ) AS record, r.created_at
      FROM sent r
      LEFT JOIN users u ON u.id = r.requester_id
      LEFT JOIN users holder ON holder.id = (r.record->>'sub_admin_id')::integer
      LEFT JOIN users giver ON giver.id = (r.record->>'admin_id')::integer
      LEFT JOIN users reviewer ON reviewer.id = r.reviewer_id
      LEFT JOIN sites s ON s.id = $1
    )
    SELECT
      COALESCE((SELECT jsonb_agg(record ORDER BY created_at DESC) FROM received_details), '[]'::jsonb) AS received,
      COALESCE((SELECT jsonb_agg(record ORDER BY created_at DESC) FROM (
        SELECT * FROM sent_details ORDER BY created_at DESC LIMIT 100
      ) recent), '[]'::jsonb) AS sent,
      (SELECT count(*)::integer FROM received) AS received_count,
      COALESCE((SELECT sum(debit) FROM received), 0) AS debit,
      COALESCE((SELECT sum(credit) FROM received), 0) AS credit,
      ((SELECT count(*) FROM imprest_expense_requests WHERE site_id=$1 AND sub_admin_id=$2 AND status='PENDING' AND $4)
       + (SELECT count(*) FROM imprest_returns WHERE site_id=$1 AND sub_admin_id=$2 AND status='PENDING' AND $4)
       + (SELECT count(*) FROM imprest_allocations WHERE site_id=$1 AND admin_id=$2 AND status='PENDING_RECEIPT' AND ($4 OR $3)))::integer AS sent_pending
  `, [siteId, userId, isAdmin, canReadPersonal, canManage]);
  const row = rows[0];
  return {
    received: row.received,
    sent: row.sent,
    counts: { received: row.received_count, sent_pending: row.sent_pending },
    totals: { debit: Number(row.debit), credit: Number(row.credit) },
  };
}
