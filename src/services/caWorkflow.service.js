import pool from '../config/db.js';

const fail = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const admin = actor => ['admin', 'super_admin'].includes(actor?.role);
const keyFor = (org, id) => `ca_excel_upload:${org}:${id}`;
const validId = value => /^\d+$/.test(String(value)) && Number.isSafeInteger(Number(value)) && Number(value) > 0 && Number(value) <= 2147483647;

export async function excelUploadAllowed(actor, db = pool) {
  if (admin(actor)) return true;
  if (actor?.role !== 'sub_admin') return false;
  const { rows } = await db.query('SELECT setting_value FROM application_settings WHERE site_id IS NULL AND setting_key=$1', [keyFor(actor.organization_id, actor.id)]);
  return rows[0]?.setting_value === true;
}

export async function listCaWorkflowUsers(actor, db = pool) {
  if (!admin(actor)) throw fail('Only admins can manage CA Workflow.', 403);
  const { rows } = await db.query(`SELECT u.id,u.name,u.role,
      (u.role IN ('admin','super_admin')) AS admin_access,
      (u.role IN ('admin','super_admin') OR s.setting_value='true'::jsonb) IS TRUE AS excel_upload_enabled
    FROM users u LEFT JOIN application_settings s ON s.site_id IS NULL
      AND s.setting_key=concat('ca_excel_upload:',u.organization_id,':',u.id)
    WHERE u.organization_id=$1 AND u.is_active=true AND u.role IN ('admin','super_admin','sub_admin')
    ORDER BY CASE u.role WHEN 'super_admin' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END,lower(u.name),u.id`, [actor.organization_id]);
  return rows;
}

export async function setCaWorkflowUser(actor, userId, enabled, db = pool) {
  if (!admin(actor)) throw fail('Only admins can manage CA Workflow.', 403);
  if (!validId(userId) || typeof enabled !== 'boolean') throw fail('Choose a valid user and a boolean enabled value.');
  const { rows } = await db.query(`INSERT INTO application_settings(site_id,setting_key,setting_value,updated_by,updated_at)
    SELECT NULL,concat('ca_excel_upload:',organization_id,':',id),to_jsonb($3::boolean),$4,now() FROM users
    WHERE id=$1 AND organization_id=$2 AND is_active=true AND role='sub_admin'
    ON CONFLICT (setting_key) WHERE site_id IS NULL DO UPDATE SET
      setting_value=EXCLUDED.setting_value,updated_by=EXCLUDED.updated_by,updated_at=now()
    RETURNING setting_value`, [Number(userId), actor.organization_id, enabled, actor.id]);
  if (!rows.length) throw fail('Active sub-admin not found in your organisation. Admins always have access.', 404);
  return { user_id: Number(userId), excel_upload_enabled: rows[0].setting_value === true };
}

export async function requireExcelUpload(req, res, next) {
  try {
    if (!await excelUploadAllowed(req.user)) return res.status(403).json({ message: 'Excel upload is not enabled for your account. Ask an admin to enable it in Settings → CA Workflow.' });
    next();
  } catch (error) { next(error); }
}

export async function assertImportSite(actor, siteId, db = pool) {
  if (!validId(siteId)) throw fail('Select a valid site.');
  const { rows } = await db.query(`SELECT s.id FROM sites s WHERE s.id=$1
    AND ($3::boolean OR s.organization_id=$2)
    AND ($4::boolean OR EXISTS(SELECT 1 FROM user_sites us WHERE us.site_id=s.id AND us.user_id=$5))`,
  [Number(siteId), actor.organization_id, actor.role === 'super_admin', admin(actor), actor.id]);
  if (!rows.length) throw fail('This site is unavailable to your account.', 403);
}
