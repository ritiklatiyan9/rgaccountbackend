import pool from '../config/db.js';

const MODULES = Object.freeze({ wallet: { defaultWrite: false }, expenses: { defaultWrite: true } });
const accessError = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });

function validateModule(actor, module) {
  if (!['admin', 'super_admin'].includes(actor?.role)) throw accessError('Only admins can manage user visibility.', 403);
  if (!Object.hasOwn(MODULES, module)) throw accessError('Unknown visibility module.');
  return MODULES[module];
}

export async function listModuleVisibility(actor, module, database = pool) {
  validateModule(actor, module);
  const { rows } = await database.query(`SELECT u.id,u.name,u.role,
      (u.role IN ('admin','super_admin') OR (p.can_read=true AND p.can_view_all=true)) IS TRUE AS view_all,
      (u.role IN ('admin','super_admin')) AS admin_access
    FROM users u LEFT JOIN user_permissions p ON p.user_id=u.id AND p.module=$2
    WHERE u.organization_id=$1 AND u.is_active=true AND u.role IN ('admin','super_admin','sub_admin')
    ORDER BY CASE u.role WHEN 'super_admin' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END,lower(u.name),u.id`,
  [actor.organization_id, module]);
  return rows;
}

export async function setModuleVisibility(actor, module, userId, enabled, database = pool) {
  const config = validateModule(actor, module);
  if (typeof enabled !== 'boolean') throw accessError('enabled must be a boolean');
  const id = Number(userId);
  if (!/^\d+$/.test(String(userId)) || !Number.isSafeInteger(id) || id < 1 || id > 2147483647) throw accessError('Choose a valid user.');
  // Match the module's existing defaults for a missing row. On an existing
  // grant only View and All Entries change; editing/deletion rights stay intact.
  const { rows } = await database.query(`INSERT INTO user_permissions
      (user_id,module,can_read,can_write,can_update,can_delete,can_restore,can_view_all,updated_at)
    SELECT id,$4,true,$5,$5,false,false,$3,now() FROM users
    WHERE id=$1 AND organization_id=$2 AND is_active=true AND role='sub_admin'
    ON CONFLICT (user_id,module) DO UPDATE SET
      can_read=CASE WHEN EXCLUDED.can_view_all THEN true ELSE user_permissions.can_read END,
      can_view_all=EXCLUDED.can_view_all,updated_at=now()
    RETURNING user_id,can_view_all`, [id, actor.organization_id, enabled, module, config.defaultWrite]);
  if (!rows[0]) throw accessError('Active sub-admin not found in your organization. Admins already have full visibility.', 404);
  return { user_id: rows[0].user_id, view_all: rows[0].can_view_all };
}
