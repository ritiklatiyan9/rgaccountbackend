export async function linkSelectedMemberPlot(db, { plotId, memberId, siteId }) {
  if (plotId == null || plotId === '') return;
  if (!['string', 'number'].includes(typeof plotId) || !Number.isSafeInteger(Number(plotId)) || Number(plotId) <= 0) {
    throw Object.assign(new Error('Select a valid plot.'), { statusCode: 400 });
  }
  const { rows: [plot] } = await db.query(`SELECT p.id,
    (to_jsonb(p)->>'buyer_member_id')::integer AS buyer_member_id
    FROM plots p WHERE p.id = $1 AND p.site_id = $2 FOR UPDATE`, [Number(plotId), siteId]);
  if (!plot) throw Object.assign(new Error('Select a plot from this user’s site.'), { statusCode: 400 });
  if (plot.buyer_member_id != null && Number(plot.buyer_member_id) !== Number(memberId)) {
    throw Object.assign(new Error('This plot is already linked to another user. Update its buyer link from Plot Payments first.'), { statusCode: 409 });
  }
  try {
    const result = await db.query(`UPDATE plots p SET buyer_member_id = m.id, updated_at = NOW()
      FROM members m WHERE p.id = $1 AND p.site_id = $3 AND m.id = $2 AND m.site_id = p.site_id
      RETURNING p.id`, [Number(plotId), memberId, siteId]);
    if (!result.rows.length) throw Object.assign(new Error('The user or plot changed. Please refresh and try again.'), { statusCode: 409 });
  } catch (error) {
    if (error.code === '42703') throw Object.assign(new Error('Plot linking is not ready. Apply the plot buyer migration on the server and try again.'), { statusCode: 409 });
    throw error;
  }
}
