const fail = (statusCode, message) => { throw Object.assign(new Error(message), { statusCode }); };
export const positiveId = value => /^\d+$/.test(String(value)) && Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : null;

async function settingsSite(db, actor, siteId) {
  if (!['admin', 'super_admin'].includes(actor?.role)) fail(403, 'Only admins can manage Imprest access');
  if (!positiveId(siteId)) fail(400, 'A valid site_id is required');
  const { rows } = await db.query('SELECT id, organization_id FROM sites WHERE id=$1', [siteId]);
  if (!rows[0]) fail(404, 'Site not found');
  if (actor.role !== 'super_admin' && Number(rows[0].organization_id) !== Number(actor.organization_id || 1)) fail(403, 'Access denied to this site');
  return rows[0];
}

async function sitePeople(db, site) {
  return (await db.query(`SELECT u.id, u.name, u.email, u.role FROM users u
    JOIN user_sites us ON us.user_id=u.id AND us.site_id=$1
    WHERE u.role='sub_admin' AND u.is_active=true AND u.organization_id=$2
    ORDER BY u.name, u.id`, [site.id, site.organization_id])).rows;
}

export async function getImprestManagementSettings(db, actor, siteId) {
  const site = await settingsSite(db, actor, siteId);
  const [people, { rows }] = await Promise.all([
    sitePeople(db, site),
    db.query(`SELECT u.id, COALESCE(p.can_read,false) AS enabled, COALESCE(v.visible_user_ids,'{}'::integer[]) AS visible_user_ids
      FROM users u JOIN user_sites us ON us.user_id=u.id AND us.site_id=$1
      LEFT JOIN user_permissions p ON p.user_id=u.id AND p.module='imprest_management'
      LEFT JOIN imprest_management_visibility v ON v.viewer_id=u.id AND v.site_id=$1
      WHERE u.role='sub_admin' AND u.is_active=true AND u.organization_id=$2`, [site.id, site.organization_id]),
  ]);
  const ids = new Set(people.map(person => Number(person.id)));
  const settings = new Map(rows.map(row => [Number(row.id), row]));
  return { site_id: site.id, people, users: people.map(person => ({ ...person,
    enabled: settings.get(Number(person.id))?.enabled === true,
    visible_user_ids: (settings.get(Number(person.id))?.visible_user_ids || []).filter(id => ids.has(Number(id))),
  })) };
}

export async function saveImprestManagementSettings(db, actor, viewerId, body) {
  const siteId = positiveId(body.site_id), targetId = positiveId(viewerId);
  if (!siteId || !targetId) fail(400, 'A valid site and sub-admin are required');
  if (typeof body.enabled !== 'boolean' || !Array.isArray(body.visible_user_ids)
    || body.visible_user_ids.length > 10000 || body.visible_user_ids.some(id => !positiveId(id))) {
    fail(400, 'Send enabled and a valid list of people');
  }
  const ids = [...new Set(body.visible_user_ids.map(Number))];
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const site = await settingsSite(client, actor, siteId);
    const people = await sitePeople(client, site);
    const eligible = new Set(people.map(person => Number(person.id)));
    if (!eligible.has(targetId)) fail(400, 'Choose a sub-admin assigned to this site');
    if (ids.some(id => !eligible.has(id))) fail(400, 'Selected people must be active sub-admins assigned to this site');
    await client.query(`INSERT INTO user_permissions (user_id,module,can_read,can_write,can_update,can_delete,can_restore,can_view_all)
      VALUES ($1,'imprest_management',$2,false,false,false,false,false)
      ON CONFLICT (user_id,module) DO UPDATE SET can_read=EXCLUDED.can_read,updated_at=now()`, [targetId, body.enabled]);
    await client.query(`INSERT INTO imprest_management_visibility(viewer_id,site_id,visible_user_ids,updated_by)
      VALUES ($1,$2,$3,$4) ON CONFLICT(viewer_id,site_id) DO UPDATE
      SET visible_user_ids=EXCLUDED.visible_user_ids,updated_by=EXCLUDED.updated_by,updated_at=now()`, [targetId, siteId, ids, actor.id]);
    await client.query('COMMIT');
    return { user_id: targetId, site_id: siteId, enabled: body.enabled, visible_user_ids: ids };
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

// Resolve on every request. Saved IDs alone never bypass current site membership
// or organisation boundaries, even after a person is moved to another site.
export async function visibleImprestPeople(db, actor, siteId) {
  const { rows } = await db.query(`SELECT u.id FROM imprest_management_visibility v
    JOIN sites s ON s.id=v.site_id AND s.organization_id=$3
    JOIN user_sites viewer_site ON viewer_site.user_id=v.viewer_id AND viewer_site.site_id=v.site_id
    JOIN users u ON u.id=ANY(v.visible_user_ids) AND u.role='sub_admin' AND u.is_active=true AND u.organization_id=s.organization_id
    JOIN user_sites target_site ON target_site.user_id=u.id AND target_site.site_id=v.site_id
    WHERE v.viewer_id=$1 AND v.site_id=$2`, [actor.id, siteId, actor.organization_id || 1]);
  return rows.map(row => Number(row.id));
}
