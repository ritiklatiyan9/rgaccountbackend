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

const requireSeekActor = actor => {
  if (!['admin', 'super_admin', 'sub_admin'].includes(actor?.role)) throw fail('Access denied', 403);
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
    sp.asked_to, au.name AS asked_to_name, sp.title, sp.amount, sp.party_name, sp.reason, sp.attachments, sp.priority,
    sp.status, sp.decided_by, du.name AS decided_by_name, sp.decided_at, sp.decision_note,
    sp.requester_seen_at, sp.created_at, sp.updated_at, sp.comment_count, sp.last_comment_at,
    COALESCE(cr.last_comment_id, 0) AS last_read_comment_id,
    (sp.status = 'pending' AND ($4::boolean OR COALESCE(sp.asked_to = $2, false))) AS can_decide,
    CASE WHEN sp.status = 'cancelled' THEN sp.updated_at ELSE sp.decided_at END AS resolved_at
  FROM seek_permissions sp
  JOIN sites s ON s.id = sp.site_id
  JOIN users ru ON ru.id = sp.requested_by
  LEFT JOIN users au ON au.id = sp.asked_to
  LEFT JOIN users du ON du.id = sp.decided_by
  LEFT JOIN seek_permission_comment_reads cr ON cr.request_id = sp.id AND cr.user_id = $2`;

// Stored S3 URLs never leave the server: clients get name/type/size and ask
// GET /:id/attachments/:index for a fresh signed link when they open one.
const publicRow = row => {
  if (!row) return row;
  const { last_read_comment_id, ...rest } = row;
  return { ...rest, comment_count: Number(row.comment_count || 0), unread_comments: Number(row.unread_comments || 0),
    attachments: (row.attachments || []).map(({ name, type, size }) => ({ name, type, size })) };
};

// Shared WHERE pieces; every query using them binds $2 = viewer id, $4 = viewer is admin.
const SITE_ACCESS = '($4::boolean OR EXISTS (SELECT 1 FROM user_sites us WHERE us.user_id = $2 AND us.site_id = sp.site_id))';
// Auth already reads current users. Keep service calls and socket recipients just
// as strict, including when a role, site assignment or account has been revoked.
const activeViewerSql = (userParam = '$2', orgParam = '$3', adminParam = '$4') =>
  `EXISTS (SELECT 1 FROM users viewer WHERE viewer.id = ${userParam} AND viewer.is_active
  AND viewer.organization_id = ${orgParam} AND viewer.role IN ('admin', 'super_admin', 'sub_admin')
  AND (viewer.role IN ('admin', 'super_admin')) = ${adminParam}::boolean)`;
const VIEWER_ACTIVE = activeViewerSql();
const SCOPE = {
  // Page: own requests, requests asked of me, everything for admins, plus Studio grants.
  visible: `(sp.requested_by = $2 OR sp.asked_to = $2 OR $4::boolean OR a.scope = 'all'
    OR (a.scope = 'selected' AND sp.requested_by = ANY(a.visible_user_ids)))`,
};

// Aggregate unread messages in SQL for the visible set. The indexed thread/id
// range and per-user watermark avoid fetching message bodies or a query per row.
const WITH_UNREAD = `, unread AS (
    SELECT c.request_id, count(*)::int AS unread_comments
      FROM seek_permission_comments c JOIN visible v ON v.id = c.request_id
     WHERE c.id > v.last_read_comment_id AND c.author_id <> $2 GROUP BY c.request_id
  ), entries AS (SELECT v.*, COALESCE(unread.unread_comments, 0) AS unread_comments
      FROM visible v LEFT JOIN unread ON unread.request_id = v.id)`;
const visibleSiteSql = `${ROW_SQL}
    LEFT JOIN seek_permission_access a ON a.site_id = sp.site_id AND a.user_id = $2
    WHERE sp.site_id = $1 AND s.organization_id = $3 AND ${VIEWER_ACTIVE} AND ${SITE_ACCESS} AND ${SCOPE.visible}`;

async function queryRequests(actor, siteId, db) {
  requireSeekActor(actor);
  const { rows } = await db.query(`WITH visible AS (${visibleSiteSql}
      ORDER BY COALESCE(sp.last_comment_at, sp.created_at) DESC, sp.id DESC LIMIT 500) ${WITH_UNREAD}
    SELECT * FROM entries ORDER BY COALESCE(last_comment_at, created_at) DESC, id DESC LIMIT 500`,
  [siteId, actor.id, orgOf(actor), isSeekAdmin(actor)]);
  return rows.map(publicRow);
}

// Most recently active 500 per site; only those threads need unread aggregation.
export const listSeekPermissions = (actor, { site_id } = {}, db = pool) =>
  queryRequests(actor, positiveId(site_id, 'site_id'), db);

/** Header bell: every visible pending request and conversations with new replies. */
export async function seekInbox(actor, { site_id } = {}, db = pool) {
  requireSeekActor(actor);
  const siteId = positiveId(site_id, 'site_id');
  const { rows: [inbox] } = await db.query(`WITH visible AS (${visibleSiteSql}) ${WITH_UNREAD},
    received AS (SELECT * FROM entries WHERE requested_by <> $2 AND (status = 'pending' OR unread_comments > 0)),
    sent AS (SELECT * FROM entries WHERE requested_by = $2)
    SELECT COALESCE((SELECT json_agg(r) FROM (SELECT * FROM received
        ORDER BY COALESCE(last_comment_at, created_at) DESC, id DESC LIMIT 200) r), '[]'::json) AS received,
      COALESCE((SELECT json_agg(r) FROM (SELECT * FROM sent ORDER BY
        (unread_comments > 0 OR (status IN ('approved', 'rejected') AND requester_seen_at IS NULL)) DESC,
        COALESCE(last_comment_at, created_at) DESC, id DESC LIMIT 50) r), '[]'::json) AS sent,
      (SELECT count(*)::int FROM received) AS received_count,
      (SELECT count(*)::int FROM sent WHERE status = 'pending') AS sent_pending_count,
      (SELECT count(*)::int FROM sent WHERE status IN ('approved', 'rejected') AND requester_seen_at IS NULL) AS sent_unseen_count,
      (SELECT count(*)::int FROM sent WHERE unread_comments > 0) AS sent_unread_count,
      (SELECT count(*)::int FROM sent WHERE status = 'pending' OR unread_comments > 0
        OR (status IN ('approved', 'rejected') AND requester_seen_at IS NULL)) AS sent_attention_count,
      (SELECT COALESCE(sum(unread_comments), 0)::int FROM entries) AS unread_comments_count`,
  [siteId, actor.id, orgOf(actor), isSeekAdmin(actor)]);
  return { ...inbox, received: inbox.received.map(publicRow), sent: inbox.sent.map(publicRow) };
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
  const priority = body.priority == null || body.priority === '' ? 'normal'
    : typeof body.priority === 'string' ? body.priority.trim().toLowerCase() : null;
  if (!['critical','important','normal'].includes(priority)) throw fail('Choose Critical, Important or Normal priority');

  // Everything is checked before upload, so a refused request never reaches S3.
  const { rows: [check] } = await db.query(`SELECT ${REQUESTER_ON_SITE} AS can_ask,
    EXISTS (SELECT 1 FROM (${TARGETS_SQL}) t WHERE t.id = $4) AS target_ok`, params);
  if (!check.can_ask) throw fail('Access denied to this site', 403);
  if (!check.target_ok) throw fail('Ask an admin, or a sub-admin of this site');
  const attachments = files.length ? await store(files) : [];
  const { rows: [created] } = await db.query(`INSERT INTO seek_permissions
      (site_id, requested_by, asked_to, title, amount, party_name, reason, attachments, priority)
    SELECT $1, $2, $4, $5, $6, $7, $8, $9::jsonb, $10 WHERE ${REQUESTER_ON_SITE}
    RETURNING id`, [...params, title, amount, partyName, reason, JSON.stringify(attachments), priority]);
  if (!created) throw fail('Access denied to this site', 403);
  return getSeekPermission(actor, created.id, db);
}

// One request by id ($1), returned only if the viewer may see it.
const visibleById = columns => `SELECT ${columns} FROM seek_permissions sp
  JOIN sites s ON s.id = sp.site_id
  LEFT JOIN seek_permission_access a ON a.site_id = sp.site_id AND a.user_id = $2
  WHERE sp.id = $1 AND s.organization_id = $3 AND ${VIEWER_ACTIVE} AND ${SITE_ACCESS} AND ${SCOPE.visible}`;
const viewerParams = (actor, id) => [id, actor.id, orgOf(actor), isSeekAdmin(actor)];
const visibleDetailSql = `${ROW_SQL}
  LEFT JOIN seek_permission_access a ON a.site_id = sp.site_id AND a.user_id = $2
  WHERE sp.id = $1 AND s.organization_id = $3 AND ${VIEWER_ACTIVE} AND ${SITE_ACCESS} AND ${SCOPE.visible}`;

export async function assertSeekVisible(actor, rawId, db = pool) {
  requireSeekActor(actor);
  const id = positiveId(rawId, 'request id');
  const { rows: [request] } = await db.query(visibleById('sp.id, sp.site_id, sp.requested_by, sp.asked_to'), viewerParams(actor, id));
  if (!request) throw fail('Permission request not found', 404);
  return request;
}

export async function getSeekPermission(actor, rawId, db = pool) {
  requireSeekActor(actor);
  const id = positiveId(rawId, 'request id');
  const { rows: [request] } = await db.query(`WITH visible AS (${visibleDetailSql})
    ${WITH_UNREAD} SELECT * FROM entries`, viewerParams(actor, id));
  if (!request) throw fail('Permission request not found', 404);
  return publicRow(request);
}

const COMMENT_SQL = `SELECT c.id, c.request_id, c.author_id, u.name AS author_name,
  u.role AS author_role, c.body, c.client_id, c.created_at
  FROM seek_permission_comments c JOIN users u ON u.id = c.author_id`;
const commentMetadata = request => ({ comment_count: request.comment_count,
  unread_comments: request.unread_comments, last_comment_at: request.last_comment_at });

export async function listSeekComments(actor, rawId, query = {}, db = pool) {
  requireSeekActor(actor);
  const id = positiveId(rawId, 'request id');
  const hasBefore = query.before_id !== undefined && query.before_id !== '';
  const hasAfter = query.after_id !== undefined && query.after_id !== '';
  if (hasBefore && hasAfter) throw fail('Use before_id or after_id, not both');
  const cursor = hasAfter && (query.after_id === 0 || query.after_id === '0') ? 0
    : hasBefore || hasAfter ? positiveId(hasBefore ? query.before_id : query.after_id, 'comment cursor') : null;
  const limit = query.limit === undefined ? 40 : positiveId(query.limit, 'limit');
  if (limit > 100) throw fail('limit must be 100 or fewer');
  const { rows: [result] } = await db.query(`WITH visible AS (${visibleDetailSql}) ${WITH_UNREAD},
    page AS (${COMMENT_SQL} JOIN entries ON entries.id = c.request_id
      WHERE ($5::int IS NULL OR c.id ${hasAfter ? '>' : '<'} $5)
      ORDER BY c.id ${hasAfter ? 'ASC' : 'DESC'} LIMIT $6)
    SELECT entries.comment_count, entries.unread_comments, entries.last_comment_at,
      COALESCE((SELECT json_agg(page ORDER BY page.id ${hasAfter ? 'ASC' : 'DESC'}) FROM page), '[]'::json) AS comments
    FROM entries`, [...viewerParams(actor, id), cursor, limit + 1]);
  if (!result) throw fail('Permission request not found', 404);
  const hasMore = result.comments.length > limit;
  const comments = result.comments.slice(0, limit);
  if (!hasAfter) comments.reverse();
  return { comments, has_more: hasMore, next_before_id: comments[0]?.id ?? null,
    last_comment_id: comments.at(-1)?.id ?? null, ...commentMetadata(result) };
}

const cleanComment = body => {
  if (typeof body !== 'string') throw fail('Write a comment');
  const text = body.replace(/\r\n?/g, '\n').trim();
  if (!text) throw fail('Write a comment');
  if (text.length > 4000) throw fail('Comment must be 4000 characters or fewer');
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) throw fail('Comment contains unsupported characters');
  return text;
};
const cleanClientId = value => {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw fail('A valid client_id UUID is required');
  }
  return value.toLowerCase();
};

export async function createSeekComment(actor, rawId, body = {}, db = pool) {
  requireSeekActor(actor);
  const id = positiveId(rawId, 'request id');
  const text = cleanComment(body.body);
  const clientId = cleanClientId(body.client_id);
  // Lock this request BEFORE the INSERT allocates its SERIAL id. Concurrent
  // replies therefore commit in thread order: a delta/read cursor cannot skip
  // an earlier id from an uncommitted reply. Replays never increment counters.
  const { rows: [inserted] } = await db.query(`WITH allowed AS MATERIALIZED (
      ${visibleById('sp.id')} FOR UPDATE OF sp
    ) INSERT INTO seek_permission_comments (request_id, author_id, body, client_id)
    SELECT allowed.id, $2, $5, $6::uuid FROM allowed
    ON CONFLICT (request_id, author_id, client_id) DO NOTHING RETURNING id`,
  [...viewerParams(actor, id), text, clientId]);
  // Re-check visibility even for a retry; old client ids do not grant access.
  const [request, { rows: [comment] }] = await Promise.all([
    getSeekPermission(actor, id, db),
    db.query(`WITH allowed AS (${visibleById('sp.id')}) ${COMMENT_SQL}
      JOIN allowed ON allowed.id = c.request_id WHERE c.author_id = $2 AND c.client_id = $5::uuid`,
    [...viewerParams(actor, id), clientId]),
  ]);
  if (!comment) throw fail('Unable to send comment. Please try again.', 503);
  if (comment.body !== text) throw fail('This client_id was already used for another comment', 409);
  return { comment, created: Boolean(inserted), request, ...commentMetadata(request) };
}

export async function markSeekCommentsSeen(actor, rawId, body = {}, db = pool) {
  const request = await assertSeekVisible(actor, rawId, db);
  const lastId = body.last_comment_id === 0 || body.last_comment_id === '0' ? 0 : positiveId(body.last_comment_id, 'last_comment_id');
  // Only a real id from this thread is accepted. Never advance to a guessed
  // future id, and never let a slower tab move an existing watermark backwards.
  const { rows: [seen] } = await db.query(`WITH allowed AS (${visibleById('sp.id')})
    INSERT INTO seek_permission_comment_reads (request_id, user_id, last_comment_id)
    SELECT allowed.id, $2, $5 FROM allowed WHERE $5 = 0 OR EXISTS (
      SELECT 1 FROM seek_permission_comments c WHERE c.request_id = allowed.id AND c.id = $5)
    ON CONFLICT (request_id, user_id) DO UPDATE
      SET last_comment_id = GREATEST(seek_permission_comment_reads.last_comment_id, EXCLUDED.last_comment_id), seen_at = now()
    RETURNING last_comment_id`, [...viewerParams(actor, request.id), lastId]);
  if (!seen) {
    await assertSeekVisible(actor, request.id, db);
    throw fail('last_comment_id must identify a comment in this request');
  }
  const updated = await getSeekPermission(actor, request.id, db);
  return { last_comment_id: seen.last_comment_id, ...commentMetadata(updated) };
}

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
  requireSeekActor(actor);
  const status = { approve: 'approved', reject: 'rejected' }[decision];
  if (!status) throw fail('Unknown decision');
  const id = positiveId(rawId, 'request id');
  const { rows } = await db.query(`UPDATE seek_permissions sp
      SET status = $2, decided_by = $3, decided_at = now(), decision_note = $4, updated_at = now()
     FROM sites s
    WHERE sp.id = $1 AND sp.status = 'pending' AND s.id = sp.site_id AND s.organization_id = $5
      AND ${activeViewerSql('$3', '$5', '$6')}
      AND ($6::boolean OR (sp.asked_to = $3
        AND EXISTS (SELECT 1 FROM user_sites us WHERE us.user_id = $3 AND us.site_id = sp.site_id)))
    RETURNING sp.id`, [id, status, actor.id, cleanText(note, 1000, 'Note'), orgOf(actor), isSeekAdmin(actor)]);
  if (!rows[0]) await explainMiss(actor, id, db, 'decide');
  return getSeekPermission(actor, id, db);
}

export async function cancelSeekPermission(actor, rawId, db = pool) {
  requireSeekActor(actor);
  const id = positiveId(rawId, 'request id');
  const { rows } = await db.query(`UPDATE seek_permissions SET status = 'cancelled', updated_at = now()
    WHERE id = $1 AND requested_by = $2 AND status = 'pending'
      AND EXISTS (${visibleById('sp.id')}) RETURNING id`, viewerParams(actor, id));
  if (!rows[0]) await explainMiss(actor, id, db, 'cancel');
  return getSeekPermission(actor, id, db);
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
  const { rows } = await db.query(`SELECT u.id FROM seek_permissions sp JOIN sites s ON s.id = sp.site_id
    JOIN users u ON u.organization_id = s.organization_id AND u.is_active
      AND u.role IN ('admin', 'super_admin', 'sub_admin')
    LEFT JOIN seek_permission_access a ON a.site_id = sp.site_id AND a.user_id = u.id
    WHERE sp.id = $1 AND (u.role IN ('admin', 'super_admin') OR (
      EXISTS (SELECT 1 FROM user_sites us WHERE us.user_id = u.id AND us.site_id = sp.site_id)
      AND (u.id = sp.requested_by OR u.id = sp.asked_to OR a.scope = 'all'
        OR (a.scope = 'selected' AND sp.requested_by = ANY(a.visible_user_ids)))))`, [request.id]);
  return rows.map(row => row.id);
}
