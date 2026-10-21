import pool from '../config/db.js';
import { uploadToS3 } from '../utils/aws.js';
import { memberDocumentStorage, signMemberDocumentUrl } from '../utils/memberDocumentUrls.js';

// Seek Permission: a sub-admin asks one person — an admin, or a sub-admin of the
// same site — who approves or rejects; admins can decide any request. Everything
// is per site. Settings → Seek permission studio decides whose requests a
// sub-admin may follow on a site: 'own' (default), 'all', or 'selected' people.

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

// Attachments: the browser optimizes photos and PDFs first (lib/evidenceFile.js);
// the server writes them under one S3 prefix and only ever signs keys from that
// prefix, so a stored link can never be pointed at another private document.
const ATTACHMENT_FOLDER = 'seek-permissions';
export const isOwnSeekAttachment = (url, env = process.env) =>
  memberDocumentStorage(url, env)?.Key.startsWith(`${ATTACHMENT_FOLDER}/`) === true;

// ponytail: an INSERT that fails after upload leaves an orphan object (input is
// validated first, so only a DB failure can); add an S3 lifecycle rule if it matters.
export const storeSeekFiles = files => Promise.all(files.map(async file => ({
  url: await uploadToS3(file.path, file.filename, file.mimetype, ATTACHMENT_FOLDER),
  name: String(file.originalname || 'Attachment').slice(0, 120),
  type: file.mimetype,
  size: file.size,
})));

const signSeekFile = async url => (isOwnSeekAttachment(url) ? signMemberDocumentUrl(url) : null);

const ROW_SQL = `SELECT sp.id, sp.site_id, s.name AS site_name, sp.requested_by, ru.name AS requested_by_name,
    sp.asked_to, au.name AS asked_to_name, sp.title, sp.amount, sp.party_name, sp.reason, sp.attachments,
    sp.status, sp.decided_by, du.name AS decided_by_name, sp.decided_at, sp.decision_note,
    sp.requester_seen_at, sp.created_at, sp.updated_at,
    CASE WHEN sp.status = 'cancelled' THEN sp.updated_at ELSE sp.decided_at END AS resolved_at
  FROM seek_permissions sp
  JOIN sites s ON s.id = sp.site_id
  JOIN users ru ON ru.id = sp.requested_by
  LEFT JOIN users au ON au.id = sp.asked_to
  LEFT JOIN users du ON du.id = sp.decided_by`;

// Stored S3 URLs never leave the server: clients get name/type/size and ask
// GET /:id/attachments/:index for a fresh signed link when they open one.
const publicRow = row => row && { ...row, attachments: (row.attachments || []).map(({ name, type, size }) => ({ name, type, size })) };

const findRequest = async (id, db) => publicRow((await db.query(`${ROW_SQL} WHERE sp.id = $1`, [id])).rows[0]);

// Shared WHERE pieces; every query using them binds $2 = viewer id, $4 = viewer is admin.
const SITE_ACCESS = '($4::boolean OR EXISTS (SELECT 1 FROM user_sites us WHERE us.user_id = $2 AND us.site_id = sp.site_id))';
const SCOPE = {
  // Page: own requests, requests asked of me, everything for admins, plus Studio grants.
  visible: `(sp.requested_by = $2 OR sp.asked_to = $2 OR $4::boolean OR a.scope = 'all'
    OR (a.scope = 'selected' AND sp.requested_by = ANY(a.visible_user_ids)))`,
  sent: 'sp.requested_by = $2',
  // Bell: open requests asked of me; any with nobody picked (before the picker) go to admins.
  received: `sp.status = 'pending' AND (sp.asked_to = $2 OR (sp.asked_to IS NULL AND $4::boolean))`,
};

// One query per list: organisation, site assignment and visibility are all in the
// WHERE clause, so nobody receives a row the rules do not allow.
async function queryRequests(actor, siteId, scope, limit, db) {
  const { rows } = await db.query(`${ROW_SQL}
    LEFT JOIN seek_permission_access a ON a.site_id = sp.site_id AND a.user_id = $2
    WHERE sp.site_id = $1 AND s.organization_id = $3 AND ${SITE_ACCESS} AND ${SCOPE[scope]}
    ORDER BY sp.created_at DESC, sp.id DESC
    LIMIT $5`, [siteId, actor.id, orgOf(actor), isSeekAdmin(actor), limit]);
  return rows.map(publicRow);
}

// ponytail: newest 500 per site, client-side filters; add paging when a site outgrows it.
export const listSeekPermissions = (actor, { site_id } = {}, db = pool) =>
  queryRequests(actor, positiveId(site_id, 'site_id'), 'visible', 500, db);

/** Header bell: open requests asked of me, plus a requester's own requests. */
export async function seekInbox(actor, { site_id } = {}, db = pool) {
  const siteId = positiveId(site_id, 'site_id');
  const [received, sent] = await Promise.all([
    queryRequests(actor, siteId, 'received', 200, db),
    actor?.role === 'sub_admin' ? queryRequests(actor, siteId, 'sent', 50, db) : [],
  ]);
  return { received, sent };
}

// Who a requester may ask on a site: every active admin, plus active sub-admins
// assigned to that site. Binds $1 = site, $2 = requester, $3 = organisation.
const TARGETS_SQL = `SELECT u.id, u.name, u.role FROM users u
  WHERE u.organization_id = $3 AND u.is_active AND u.id <> $2
    AND (u.role IN ('admin', 'super_admin')
      OR (u.role = 'sub_admin' AND EXISTS (SELECT 1 FROM user_sites us WHERE us.user_id = u.id AND us.site_id = $1)))`;
const REQUESTER_ON_SITE = `EXISTS (SELECT 1 FROM sites s JOIN user_sites us ON us.site_id = s.id AND us.user_id = $2
  WHERE s.id = $1 AND s.organization_id = $3)`;

export async function listSeekTargets(actor, { site_id } = {}, db = pool) {
  const { rows } = await db.query(`SELECT t.id, t.name, t.role FROM (${TARGETS_SQL}) t WHERE ${REQUESTER_ON_SITE}
    ORDER BY CASE t.role WHEN 'admin' THEN 0 WHEN 'super_admin' THEN 1 ELSE 2 END, lower(t.name), t.id`,
  [positiveId(site_id, 'site_id'), actor.id, orgOf(actor)]);
  return rows;
}

export async function createSeekPermission(actor, body = {}, db = pool, files = [], store = storeSeekFiles) {
  if (actor?.role !== 'sub_admin') throw fail('Admins decide requests — only sub-admins seek permission.', 403);
  const siteId = positiveId(body.site_id, 'site_id');
  const title = cleanText(body.title, 200, 'Request');
  if (!title) throw fail('Write what you need permission for');
  if (!body.asked_to) throw fail('Choose who to ask');
  const params = [siteId, actor.id, orgOf(actor), positiveId(body.asked_to, 'person to ask')];
  let amount = null;
  if (body.amount !== undefined && body.amount !== null && String(body.amount).trim() !== '') {
    amount = Math.round(Number(body.amount) * 100) / 100;
    if (!Number.isFinite(amount) || amount <= 0 || amount >= 1e12) throw fail('Amount must be a positive number');
  }
  const partyName = cleanText(body.party_name, 120, 'Person');
  const reason = cleanText(body.reason, 2000, 'Reason');

  // Everything is checked before upload, so a refused request never reaches S3.
  const { rows: [check] } = await db.query(`SELECT ${REQUESTER_ON_SITE} AS can_ask,
    EXISTS (SELECT 1 FROM (${TARGETS_SQL}) t WHERE t.id = $4) AS target_ok`, params);
  if (!check.can_ask) throw fail('Access denied to this site', 403);
  if (!check.target_ok) throw fail('Ask an admin, or a sub-admin of this site');
  const attachments = files.length ? await store(files) : [];
  const { rows: [created] } = await db.query(`INSERT INTO seek_permissions
      (site_id, requested_by, asked_to, title, amount, party_name, reason, attachments)
    SELECT $1, $2, $4, $5, $6, $7, $8, $9::jsonb WHERE ${REQUESTER_ON_SITE}
    RETURNING id`, [...params, title, amount, partyName, reason, JSON.stringify(attachments)]);
  if (!created) throw fail('Access denied to this site', 403);
  return findRequest(created.id, db);
}

// One request by id ($1), returned only if the viewer may see it.
const visibleById = columns => `SELECT ${columns} FROM seek_permissions sp
  JOIN sites s ON s.id = sp.site_id
  LEFT JOIN seek_permission_access a ON a.site_id = sp.site_id AND a.user_id = $2
  WHERE sp.id = $1 AND s.organization_id = $3 AND ${SITE_ACCESS} AND ${SCOPE.visible}`;
const viewerParams = (actor, id) => [id, actor.id, orgOf(actor), isSeekAdmin(actor)];

// Why a guarded UPDATE matched nothing: hidden → 404, decided → 409, not yours → 403.
async function explainMiss(actor, id, db, action) {
  const { rows: [row] } = await db.query(visibleById('sp.status'), viewerParams(actor, id));
  if (!row) throw fail('Permission request not found', 404);
  if (row.status !== 'pending') throw fail(`This request is already ${row.status}`, 409);
  throw fail(action === 'cancel' ? 'Only the requester can withdraw this request'
    : 'Only the person asked or an admin can decide this request', 403);
}

// The person asked decides (while still on the site); admins can decide any
// request. The status guard makes it race-safe: the first decision wins, later
// ones get a 409.
export async function decideSeekPermission(actor, rawId, decision, note, db = pool) {
  const status = { approve: 'approved', reject: 'rejected' }[decision];
  if (!status) throw fail('Unknown decision');
  const id = positiveId(rawId, 'request id');
  const { rows } = await db.query(`UPDATE seek_permissions sp
      SET status = $2, decided_by = $3, decided_at = now(), decision_note = $4, updated_at = now()
     FROM sites s
    WHERE sp.id = $1 AND sp.status = 'pending' AND s.id = sp.site_id AND s.organization_id = $5
      AND ($6::boolean OR (sp.asked_to = $3
        AND EXISTS (SELECT 1 FROM user_sites us WHERE us.user_id = $3 AND us.site_id = sp.site_id)))
    RETURNING sp.id`, [id, status, actor.id, cleanText(note, 1000, 'Note'), orgOf(actor), isSeekAdmin(actor)]);
  if (!rows[0]) await explainMiss(actor, id, db, 'decide');
  return findRequest(id, db);
}

export async function cancelSeekPermission(actor, rawId, db = pool) {
  const id = positiveId(rawId, 'request id');
  const { rows } = await db.query(`UPDATE seek_permissions SET status = 'cancelled', updated_at = now()
    WHERE id = $1 AND requested_by = $2 AND status = 'pending' RETURNING id`, [id, actor.id]);
  if (!rows[0]) await explainMiss(actor, id, db, 'cancel');
  return findRequest(id, db);
}

/** A fresh signed link to one attachment, for anyone who can see the request. */
export async function seekAttachmentUrl(actor, rawId, rawIndex, db = pool, sign = signSeekFile) {
  const id = positiveId(rawId, 'request id');
  const index = Number(rawIndex);
  const { rows: [row] } = await db.query(visibleById('sp.attachments'), viewerParams(actor, id));
  const file = Number.isInteger(index) ? row?.attachments?.[index] : null;
  const url = file && await sign(file.url);
  if (!url) throw fail('Attachment not found', 404);
  return { url, name: file.name, type: file.type };
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

/** Everyone whose bell or page shows this request: admins, requester, person asked, Studio viewers. */
export async function seekRecipients(request, db = pool) {
  const { rows } = await db.query(`SELECT u.id FROM users u JOIN sites s ON s.organization_id = u.organization_id
     WHERE s.id = $1 AND u.is_active AND u.role IN ('admin', 'super_admin')
    UNION SELECT id FROM unnest(ARRAY[$2::int, $3::int]) AS id WHERE id IS NOT NULL
    UNION SELECT a.user_id FROM seek_permission_access a
     WHERE a.site_id = $1 AND (a.scope = 'all' OR (a.scope = 'selected' AND $2::int = ANY(a.visible_user_ids)))`,
  [request.site_id, request.requested_by, request.asked_to ?? null]);
  return rows.map(row => row.id);
}
