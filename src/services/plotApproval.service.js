/** Validate delegation against the same active/site scope as the approver picker. */
export async function validatePlotApprover(db, siteId, value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw Object.assign(new Error('Select an admin to approve this plot.'), { status: 400, statusCode: 400 });
  }
  const { rows } = await db.query(`SELECT u.id FROM users u WHERE u.id = $1 AND u.is_active = true
    AND (u.role IN ('admin', 'super_admin') OR (u.role = 'sub_admin'
      AND EXISTS (SELECT 1 FROM user_sites us WHERE us.user_id = u.id AND us.site_id = $2)))`, [id, siteId]);
  if (!rows[0]) throw Object.assign(new Error('Select an active approver for this site.'), { status: 400, statusCode: 400 });
  return id;
}
