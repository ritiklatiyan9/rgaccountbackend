import pool from '../config/db.js';

// Seek Permission: sub-admins ask, admins decide, everything is per site.
// Settings → Seek permission studio decides whose requests a sub-admin may see
// on a site: 'own' (default), 'all', or 'selected' people.

const fail = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const SCOPES = ['own', 'all', 'selected'];
export const isSeekAdmin = actor => actor?.role === 'admin' || actor?.role === 'super_admin';
const orgOf = actor => actor?.organization_id || 1;

const positiveId = (value, label) => {
  const id = Number(value);
  if (!/^\d+$/.test(String(value ?? '')) || !Number.isSafeInteger(id) || id < 1 || id > 2147483647) {
    throw fail(`A valid ${label} is required`);
  }
  return id;
};

const cleanText = (value, max, label) => {
  const text = String(value ?? '').trim();
  if (text.length > max) throw fail(`${label} must be ${max} characters or fewer`);
  return text || null;
};

const requireAdmin = (actor) => {
  if (!isSeekAdmin(actor)) throw fail('Only admins can do this', 403);
};

const ROW_SQL = `SELECT sp.id, sp.site_id, s.name AS site_name, sp.requested_by, ru.name AS requested_by_name,
    sp.title, sp.amount, sp.party_name, sp.reason, sp.status, sp.decided_by, du.name AS decided_by_name,
    sp.decided_at, sp.decision_note, sp.requester_seen_at, sp.created_at, sp.updated_at,
    CASE WHEN sp.status = 'cancelled' THEN sp.updated_at ELSE sp.decided_at END AS resolved_at
  FROM seek_permissions sp
  JOIN sites s ON s.id = sp.site_id
  JOIN users ru ON ru.id = sp.requested_by
  LEFT JOIN users du ON du.id = sp.decided_by`;

const findRequest = async (id, db) => (await db.query(`${ROW_SQL} WHERE sp.id = $1`, [id])).rows[0];

// One query: organisation, site assignment and Studio visibility all live in the
// WHERE clause, so a sub-admin never receives a row the rules do not allow.
async function queryRequests(actor, siteId, { status = null, mine = false, limit = 500 }, db) {
  const { rows } = await db.query(`${ROW_SQL}
    LEFT JOIN seek_permission_access a ON a.site_id = sp.site_id AND a.user_id = $2
    WHERE sp.site_id = $1 AND s.organization_id = $3
      AND ($4::boolean OR EXISTS (SELECT 1 FROM user_sites us WHERE us.user_id = $2 AND us.site_id = sp.site_id))
      AND (sp.requested_by = $2 OR (NOT $5::boolean AND ($4::boolean OR a.scope = 'all'
        OR (a.scope = 'selected' AND sp.requested_by = ANY(a.visible_user_ids)))))
      AND ($6::text IS NULL OR sp.status = $6::text)
    ORDER BY sp.created_at DESC, sp.id DESC
    LIMIT $7`, [siteId, actor.id, orgOf(actor), isSeekAdmin(actor), mine, status, limit]);
  return rows;
}

// ponytail: newest 500 per site, client-side filters; add paging when a site outgrows it.
export const listSeekPermissions = (actor, { site_id } = {}, db = pool) =>
  queryRequests(actor, positiveId(site_id, 'site_id'), {}, db);

/** Header bell: admins get the site's open requests, sub-admins their own. */
export async function seekInbox(actor, { site_id } = {}, db = pool) {
  const siteId = positiveId(site_id, 'site_id');
  return isSeekAdmin(actor)
    ? { received: await queryRequests(actor, siteId, { status: 'pending', limit: 200 }, db), sent: [] }
    : { received: [], sent: await queryRequests(actor, siteId, { mine: true, limit: 50 }, db) };
}

export async function createSeekPermission(actor, body = {}, db = pool) {
  if (actor?.role !== 'sub_admin') throw fail('Admins decide requests — only sub-admins seek permission.', 403);
  const siteId = positiveId(body.site_id, 'site_id');
  const title = cleanText(body.title, 200, 'Request');
  if (!title) throw fail('Write what you need permission for');
  let amount = null;
  if (body.amount !== undefined && body.amount !== null && String(body.amount).trim() !== '') {
    amount = Math.round(Number(body.amount) * 100) / 100;
    if (!Number.isFinite(amount) || amount <= 0 || amount >= 1e12) throw fail('Amount must be a positive number');
  }
  const { rows: [created] } = await db.query(`INSERT INTO seek_permissions (site_id, requested_by, title, amount, party_name, reason)
    SELECT s.id, $2, $3, $4, $5, $6 FROM sites s
     WHERE s.id = $1 AND s.organization_id = $7
       AND EXISTS (SELECT 1 FROM user_sites us WHERE us.user_id = $2 AND us.site_id = s.id)
    RETURNING id`, [siteId, actor.id, title, amount, cleanText(body.party_name, 120, 'Person'),
    cleanText(body.reason, 2000, 'Reason'), orgOf(actor)]);
  if (!created) throw fail('Access denied to this site', 403);
  return findRequest(created.id, db);
}

async function explainMiss(actor, id, db, ownOnly = false) {
  const { rows: [row] } = await db.query(`SELECT sp.status, sp.requested_by FROM seek_permissions sp
    JOIN sites s ON s.id = sp.site_id WHERE sp.id = $1 AND s.organization_id = $2`, [id, orgOf(actor)]);
  if (!row || (ownOnly && row.requested_by !== actor.id)) throw fail('Permission request not found', 404);
  throw fail(`This request is already ${row.status}`, 409);
}

// The status guard makes decisions race-safe without a transaction: the first
// approve/reject/cancel wins and every later one gets a 409.
export async function decideSeekPermission(actor, rawId, decision, note, db = pool) {
  requireAdmin(actor);
  const status = { approve: 'approved', reject: 'rejected' }[decision];
  if (!status) throw fail('Unknown decision');
  const id = positiveId(rawId, 'request id');
  const { rows } = await db.query(`UPDATE seek_permissions sp
      SET status = $2, decided_by = $3, decided_at = now(), decision_note = $4, updated_at = now()
     FROM sites s
    WHERE sp.id = $1 AND sp.status = 'pending' AND s.id = sp.site_id AND s.organization_id = $5
    RETURNING sp.id`, [id, status, actor.id, cleanText(note, 1000, 'Note'), orgOf(actor)]);
  if (!rows[0]) await explainMiss(actor, id, db);
  return findRequest(id, db);
}

export async function cancelSeekPermission(actor, rawId, db = pool) {
  const id = positiveId(rawId, 'request id');
  const { rows } = await db.query(`UPDATE seek_permissions SET status = 'cancelled', updated_at = now()
    WHERE id = $1 AND requested_by = $2 AND status = 'pending' RETURNING id`, [id, actor.id]);
  if (!rows[0]) await explainMiss(actor, id, db, true);
  return findRequest(id, db);
}

/** The requester has seen the decisions on this site — clears their bell. */
export async function markSeekSeen(actor, { site_id } = {}, db = pool) {
  const { rows } = await db.query(`UPDATE seek_permissions SET requester_seen_at = now()
    WHERE requested_by = $1 AND site_id = $2 AND status IN ('approved', 'rejected') AND requester_seen_at IS NULL
    RETURNING id`, [actor.id, positiveId(site_id, 'site_id')]);
  return rows.length;
}

// Studio: every active sub-admin assigned to the site, with their visibility.
const SITE_PEOPLE_SQL = `SELECT u.id, u.name FROM users u
  JOIN user_sites us ON us.user_id = u.id AND us.site_id = $1
  JOIN sites s ON s.id = us.site_id AND s.organization_id = $2
  WHERE u.organization_id = $2 AND u.is_active AND u.role = 'sub_admin'`;

export async function listSeekAccess(actor, { site_id } = {}, db = pool) {
  requireAdmin(actor);
  const { rows } = await db.query(`SELECT p.id, p.name, COALESCE(a.scope, 'own') AS scope,
      COALESCE(a.visible_user_ids, '{}') AS user_ids
    FROM (${SITE_PEOPLE_SQL}) p
    LEFT JOIN seek_permission_access a ON a.site_id = $1 AND a.user_id = p.id
    ORDER BY lower(p.name), p.id`, [positiveId(site_id, 'site_id'), orgOf(actor)]);
  return rows;
}

export async function setSeekAccess(actor, rawUserId, body = {}, db = pool) {
  requireAdmin(actor);
  const siteId = positiveId(body.site_id, 'site_id');
  const userId = positiveId(rawUserId, 'user');
  if (!SCOPES.includes(body.scope)) throw fail('scope must be own, all or selected');
  const ids = body.scope === 'selected'
    ? [...new Set((Array.isArray(body.user_ids) ? body.user_ids : []).map(value => positiveId(value, 'user')))]
      .filter(id => id !== userId)
    : [];
  // Both the viewer and the people they may see must be sub-admins of this site.
  const { rows: [saved] } = await db.query(`WITH people AS (${SITE_PEOPLE_SQL})
    INSERT INTO seek_permission_access (site_id, user_id, scope, visible_user_ids, updated_by)
    SELECT $1, $3, $4, ARRAY(SELECT id FROM people WHERE id = ANY($5::int[]) ORDER BY id), $6
     WHERE EXISTS (SELECT 1 FROM people WHERE id = $3)
    ON CONFLICT (site_id, user_id) DO UPDATE SET scope = EXCLUDED.scope,
      visible_user_ids = EXCLUDED.visible_user_ids, updated_by = EXCLUDED.updated_by, updated_at = now()
    RETURNING user_id AS id, scope, visible_user_ids AS user_ids`, [siteId, orgOf(actor), userId, body.scope, ids, actor.id]);
  if (!saved) throw fail('Active sub-admin assigned to this site not found', 404);
  return saved;
}

/** Everyone whose bell or page shows this request: admins, the requester, Studio viewers. */
export async function seekRecipients(request, db = pool) {
  const { rows } = await db.query(`SELECT u.id FROM users u JOIN sites s ON s.organization_id = u.organization_id
     WHERE s.id = $1 AND u.is_active AND u.role IN ('admin', 'super_admin')
    UNION SELECT $2::int
    UNION SELECT a.user_id FROM seek_permission_access a
     WHERE a.site_id = $1 AND (a.scope = 'all' OR (a.scope = 'selected' AND $2::int = ANY(a.visible_user_ids)))`,
  [request.site_id, request.requested_by]);
  return rows.map(row => row.id);
}
