import { coApplicantsForWrite, plotCoApplicants } from './plotCoApplicants.service.js';
export async function linkSelectedMemberPlot(db, { plotId, memberId, siteId, plotRole = 'buyer', relation = '' }) {
  if (plotId == null || plotId === '') return;
  if (!['string', 'number'].includes(typeof plotId) || !Number.isSafeInteger(Number(plotId)) || Number(plotId) <= 0) {
    throw Object.assign(new Error('Select a valid plot.'), { statusCode: 400 });
  }
  if (!['buyer', 'co_applicant'].includes(plotRole)) throw Object.assign(new Error('Select buyer or co-applicant for this plot.'), { statusCode: 400 });
  const { rows: [plot] } = await db.query(`SELECT p.*,
    (to_jsonb(p)->>'buyer_member_id')::integer AS buyer_member_id
    FROM plots p WHERE p.id = $1 AND p.site_id = $2 FOR UPDATE`, [Number(plotId), siteId]);
  if (!plot) throw Object.assign(new Error('Select a plot from this user’s site.'), { statusCode: 400 });
  if (plot.booking_cancelled_at) throw Object.assign(new Error('This cancelled booking is preserved. Link the user to the current booking.'), { statusCode: 409 });
  if (plotRole === 'co_applicant') {
    const current = plotCoApplicants(plot);
    const index = current.findIndex(person => Number(person.member_id) === Number(memberId));
    const person = { member_id: memberId, relation };
    const draft = index < 0 ? [...current, person] : current.map((row, i) => i === index ? { ...row, relation } : row);
    const data = await coApplicantsForWrite({ co_applicants: draft }, siteId, db, { existing: plot });
    const keys = Object.keys(data);
    await db.query(`UPDATE plots SET ${keys.map((key, i) => `${key}=$${i + 2}`).join(',')},updated_at=NOW() WHERE id=$1`, [Number(plotId), ...Object.values(data)]);
    return;
  }
  if (plotCoApplicants(plot).some(person => Number(person.member_id) === Number(memberId))) throw Object.assign(new Error('This user is already a co-applicant. Edit the applicants in Plot Payments to make them the buyer.'), { statusCode: 409 });
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
