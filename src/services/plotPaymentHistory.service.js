// Match a physical unit within its site, block and unit type. Tower/floor keep
// identically numbered flats in separate buildings from sharing a history.
export async function readPlotPaymentHistory(pool, plotId, creatorId = null) {
  const { rows } = await pool.query(`
    SELECT pp.*, p.plot_no, p.plot_tag,
           COALESCE(NULLIF(pp.buyer_name, ''), p.buyer_name) AS buyer_name,
           p.booking_by AS booked_by, u.name AS created_by_name,
           aa.name AS assigned_admin_name
    FROM plots anchor
    JOIN plots p ON p.site_id = anchor.site_id AND (
      p.id = anchor.id OR (
        NULLIF(BTRIM(anchor.plot_no), '') IS NOT NULL
        AND UPPER(BTRIM(p.plot_no)) = UPPER(BTRIM(anchor.plot_no))
        AND UPPER(BTRIM(COALESCE(p.block, ''))) = UPPER(BTRIM(COALESCE(anchor.block, '')))
        AND COALESCE(to_jsonb(p)->>'unit_type', 'plot') = COALESCE(to_jsonb(anchor)->>'unit_type', 'plot')
        AND UPPER(BTRIM(COALESCE(to_jsonb(p)->'unit_details'->>'tower', ''))) = UPPER(BTRIM(COALESCE(to_jsonb(anchor)->'unit_details'->>'tower', '')))
        AND UPPER(BTRIM(COALESCE(to_jsonb(p)->'unit_details'->>'floor', ''))) = UPPER(BTRIM(COALESCE(to_jsonb(anchor)->'unit_details'->>'floor', '')))
      )
    )
    JOIN plot_payments pp ON pp.plot_id = p.id AND pp.site_id = p.site_id
    LEFT JOIN users u ON u.id = pp.created_by
    LEFT JOIN users aa ON aa.id = pp.assigned_admin_id
    WHERE anchor.id = $1
      AND ($2::text IS NULL OR pp.created_by = ANY(string_to_array($2::text, ',')::int[]))
    ORDER BY pp.date ASC, pp.created_at ASC, pp.id ASC
  `, [plotId, creatorId]);
  return rows;
}
