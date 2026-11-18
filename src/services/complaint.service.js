import pool from '../config/db.js';
import { signMemberDocumentUrl } from '../utils/memberDocumentUrls.js';
import { isOwnSeekAttachment, storeSeekFiles } from './seekPermission.service.js';

// Suggestions & Complaints: anyone on a site (admin or sub-admin) raises a
// complaint or a suggestion about a
// person, a module or anything else and assigns it to someone. The assignee (or
// any admin) works it: in progress → resolved / closed. The raiser can close it
// or reopen it if not satisfied. Everything is per site. Settings → Complaints
// studio decides whose complaints a sub-admin may follow: 'own' (default),
// 'all', or 'selected' people. A complaint about a person is never shown to
// that person through a Studio grant — only admins, the raiser and the assignee.

const fail = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const SCOPES = ['own', 'all', 'selected'];
const PRIORITIES = ['critical', 'important', 'normal'];
const ABOUT = ['person', 'module', 'other'];
const KINDS = ['complaint', 'suggestion'];
export const isComplaintAdmin = actor => actor?.role === 'admin' || actor?.role === 'super_admin';
const orgOf = actor => actor?.organization_id || 1;

const positiveId = (value, label) => {
  const id = Number(value);
  if (!/^\d+$/.test(String(value ?? '')) || !Number.isSafeInteger(id) || id < 1 || id > 2147483647) {
    throw fail(`A valid ${label} is required`);
  }
  return id;
};

const cleanText = (value, max, label) => {
  const text = String(value ?? '').replace(/\r\n?/g, '\n').trim();
  if (text.length > max) throw fail(`${label} must be ${max} characters or fewer`);
  return text || null;
};

const requireActor = actor => {
  if (!['admin', 'super_admin', 'sub_admin'].includes(actor?.role)) throw fail('Access denied', 403);
};

// Every query below binds $2 = viewer id, $3 = organisation, $4 = viewer is admin.
// Auth already reads current users; this keeps revoked roles/sites out as well.
const VIEWER_ACTIVE = `EXISTS (SELECT 1 FROM users viewer WHERE viewer.id = $2 AND viewer.is_active
  AND viewer.organization_id = $3 AND viewer.role IN ('admin', 'super_admin', 'sub_admin')
  AND (viewer.role IN ('admin', 'super_admin')) = $4::boolean)`;
// Admins see everything. Sub-admins on the site see what they raised, were
// assigned or had shared with them, plus Studio grants — except complaints
// about themselves.
const visibleTo = viewer => `(${viewer.admin}::boolean OR (
  EXISTS (SELECT 1 FROM user_sites us WHERE us.user_id = ${viewer.id} AND us.site_id = c.site_id)
  AND (c.raised_by = ${viewer.id} OR c.assigned_to = ${viewer.id} OR ${viewer.id} = ANY(c.shared_with)
    OR ((a.scope = 'all' OR (a.scope = 'selected'
      AND (c.raised_by = ANY(a.visible_user_ids) OR c.assigned_to = ANY(a.visible_user_ids))))
      AND c.about_user_id IS DISTINCT FROM ${viewer.id}))))`;
const VISIBLE = visibleTo({ id: '$2', admin: '$4' });

// ponytail: unread_comments is a per-row count over the (complaint_id, id) index
// above the viewer's watermark; fine for the 500-row page, aggregate in a CTE
// (like Seek Permission) if lists grow far beyond that.
const ROW_SQL = `SELECT c.id, c.site_id, s.name AS site_name, c.kind, c.raised_by, ru.name AS raised_by_name,
    c.assigned_to, au.name AS assigned_to_name, c.title, c.description, c.about_type, c.about_user_id,
    bu.name AS about_user_name, c.about_module, c.priority, c.status, c.attachments, c.resolved_at,
    c.created_at, c.updated_at, c.comment_count, c.last_comment_at, c.shared_with,
    (SELECT COALESCE(json_agg(json_build_object('id', su.id, 'name', su.name) ORDER BY lower(su.name)), '[]'::json)
      FROM users su WHERE su.id = ANY(c.shared_with)) AS shared_with_people,
    unread.unread_comments, unread.latest_unread_comment_id
  FROM complaints c
  JOIN sites s ON s.id = c.site_id
  JOIN users ru ON ru.id = c.raised_by
  JOIN users au ON au.id = c.assigned_to
  LEFT JOIN users bu ON bu.id = c.about_user_id
  LEFT JOIN complaint_comment_reads cr ON cr.complaint_id = c.id AND cr.user_id = $2
  LEFT JOIN LATERAL (SELECT count(*)::int AS unread_comments, max(cc.id) AS latest_unread_comment_id
    FROM complaint_comments cc WHERE cc.complaint_id = c.id AND cc.id > COALESCE(cr.last_comment_id, 0)
      AND cc.author_id <> $2) unread ON true
  LEFT JOIN complaint_access a ON a.site_id = c.site_id AND a.user_id = $2`;
const visibleWhere = key => `WHERE ${key} = $1 AND s.organization_id = $3 AND ${VIEWER_ACTIVE} AND ${VISIBLE}`;
const params = (actor, first) => [first, actor.id, orgOf(actor), isComplaintAdmin(actor)];

// Who may move a complaint where. Manager = assignee or any admin.
const TRANSITIONS = {
  in_progress: { from: ['open'], who: 'manager' },
  resolved: { from: ['open', 'in_progress'], who: 'manager' },
  closed: { from: ['open', 'in_progress', 'resolved'], who: 'manager_or_raiser' },
  open: { from: ['resolved', 'closed'], who: 'raiser_or_admin' },
};
const NOTE_REQUIRED = { resolved: 'Write how it was resolved', closed: 'Write why it is being closed', open: 'Write why it is being reopened' };

export function complaintActions(row, actor) {
  const me = Number(actor.id);
  const admin = isComplaintAdmin(actor);
  const manager = admin || Number(row.assigned_to) === me;
  const raiser = Number(row.raised_by) === me;
  const statuses = Object.entries(TRANSITIONS).filter(([, rule]) => rule.from.includes(row.status) && (
    rule.who === 'manager' ? manager : rule.who === 'raiser_or_admin' ? raiser || admin : manager || raiser))
    .map(([status]) => status);
  return { statuses, can_reassign: manager && ['open', 'in_progress'].includes(row.status) };
}

// Stored S3 URLs never leave the server: clients get name/type/size and ask
// GET /:id/attachments/:index for a fresh signed link when they open one.
const publicRow = (row, actor) => row && ({
  ...row,
  attachments: (row.attachments || []).map(({ name, type, size }) => ({ name, type, size })),
  ...complaintActions(row, actor),
});

export async function listComplaints(actor, { site_id } = {}, db = pool) {
  requireActor(actor);
  const { rows } = await db.query(`${ROW_SQL} ${visibleWhere('c.site_id')}
    ORDER BY c.updated_at DESC, c.id DESC LIMIT 500`, params(actor, positiveId(site_id, 'site_id')));
  return rows.map(row => publicRow(row, actor));
}

export async function getComplaint(actor, rawId, db = pool) {
  requireActor(actor);
  const { rows: [row] } = await db.query(`${ROW_SQL} ${visibleWhere('c.id')}`, params(actor, positiveId(rawId, 'complaint id')));
  if (!row) throw fail('Complaint not found', 404);
  return publicRow(row, actor);
}

/** The trail: created, status changes, reassignments (comments live in the discussion). */
export async function listComplaintEvents(actor, rawId, db = pool) {
  const complaint = await getComplaint(actor, rawId, db);
  const { rows } = await db.query(`SELECT e.id, e.kind, e.status, e.note, e.created_at, e.actor_id,
      u.name AS actor_name, u.role AS actor_role, e.assigned_to, au.name AS assigned_to_name
    FROM complaint_events e JOIN users u ON u.id = e.actor_id LEFT JOIN users au ON au.id = e.assigned_to
    WHERE e.complaint_id = $1 AND e.kind <> 'comment' ORDER BY e.id`, [complaint.id]);
  return { complaint, events: rows };
}

// People on a site: every active admin, plus active sub-admins of that site.
// Binds $1 = site, $2 = viewer, $3 = organisation.
const ASSIGNABLE = `(u.role IN ('admin', 'super_admin')
  OR (u.role = 'sub_admin' AND EXISTS (SELECT 1 FROM user_sites us WHERE us.user_id = u.id AND us.site_id = $1)))`;
const ON_SITE = `EXISTS (SELECT 1 FROM sites s WHERE s.id = $1 AND s.organization_id = $3
  AND ($4::boolean OR EXISTS (SELECT 1 FROM user_sites us WHERE us.user_id = $2 AND us.site_id = s.id)))`;

/** The form's two pickers: anyone in the organisation to complain about, and who can be assigned on this site. */
export async function listComplaintPeople(actor, { site_id } = {}, db = pool) {
  requireActor(actor);
  const { rows } = await db.query(`SELECT u.id, u.name, u.role, ${ASSIGNABLE} AS assignable FROM users u
    WHERE u.organization_id = $3 AND u.is_active AND u.id <> $2 AND u.role IN ('admin', 'super_admin', 'sub_admin') AND ${ON_SITE}
    ORDER BY CASE u.role WHEN 'admin' THEN 0 WHEN 'super_admin' THEN 1 ELSE 2 END, lower(u.name), u.id`,
  params(actor, positiveId(site_id, 'site_id')));
  return rows;
}

const signFile = async url => (isOwnSeekAttachment(url) ? signMemberDocumentUrl(url) : null);

// "Show to" list: ids from JSON or repeated multipart fields. The raiser and the
// assignee already see it; the person it is about never may.
const MAX_SHARED = 25;
function cleanShareList(value, { self, assignedTo, aboutUserId }) {
  const raw = value == null || value === '' ? [] : [].concat(value).flatMap(item => String(item).split(',')).map(item => item.trim()).filter(Boolean);
  const ids = [...new Set(raw.map(item => positiveId(item, 'person to show it to')))];
  if (aboutUserId && ids.includes(aboutUserId)) throw fail("Don't show a complaint to the person it is about");
  const shared = ids.filter(id => id !== self && id !== assignedTo);
  if (shared.length > MAX_SHARED) throw fail(`Show it to ${MAX_SHARED} people or fewer`);
  return shared;
}
// Only people who can open this site: admins, or active sub-admins assigned to it.
async function assertShareable(db, siteId, orgId, ids) {
  if (!ids.length) return;
  const { rows: [check] } = await db.query(`SELECT count(*)::int AS ok FROM users u
    WHERE u.id = ANY($2::int[]) AND u.organization_id = $3 AND u.is_active AND ${ASSIGNABLE}`, [siteId, ids, orgId]);
  if (check.ok !== ids.length) throw fail('Show it only to admins, or sub-admins of this site');
}

export async function createComplaint(actor, body = {}, db = pool, files = [], store = storeSeekFiles) {
  requireActor(actor);
  const siteId = positiveId(body.site_id, 'site_id');
  const title = cleanText(body.title, 200, 'Subject');
  if (!title) throw fail('Write what the complaint is about');
  const description = cleanText(body.description, 4000, 'Details');
  const kind = body.kind == null || body.kind === '' ? 'complaint' : String(body.kind);
  if (!KINDS.includes(kind)) throw fail('Choose Complaint or Suggestion');
  const priority = body.priority == null || body.priority === '' ? 'normal' : String(body.priority).trim().toLowerCase();
  if (!PRIORITIES.includes(priority)) throw fail('Choose Critical, Important or Normal priority');
  const aboutType = body.about_type || 'other';
  if (!ABOUT.includes(aboutType)) throw fail('Choose what the complaint is about');
  const aboutUserId = aboutType === 'person' ? positiveId(body.about_user_id, 'person') : null;
  const aboutModule = aboutType === 'module' ? cleanText(body.about_module, 80, 'Module') : null;
  if (aboutType === 'module' && !aboutModule) throw fail('Choose the module');
  if (!body.assigned_to) throw fail('Choose who to assign it to');
  const assignedTo = positiveId(body.assigned_to, 'assignee');
  if (aboutUserId && aboutUserId === assignedTo) throw fail("Don't assign a complaint to the person it is about");
  const sharedWith = cleanShareList(body.shared_with, { self: Number(actor.id), assignedTo, aboutUserId });

  // Everything is checked before upload, so a refused complaint never reaches S3.
  const base = params(actor, siteId);
  const { rows: [check] } = await db.query(`SELECT ${ON_SITE} AS on_site,
      EXISTS (SELECT 1 FROM users u WHERE u.id = $5 AND u.id <> $2 AND u.organization_id = $3 AND u.is_active AND ${ASSIGNABLE}) AS assignee_ok,
      ($6::int IS NULL OR EXISTS (SELECT 1 FROM users u WHERE u.id = $6 AND u.id <> $2 AND u.organization_id = $3
        AND u.is_active AND u.role IN ('admin', 'super_admin', 'sub_admin'))) AS about_ok`,
  [...base, assignedTo, aboutUserId]);
  if (!check.on_site) throw fail('Access denied to this site', 403);
  if (!check.assignee_ok) throw fail('Assign it to an admin, or a sub-admin of this site');
  if (!check.about_ok) throw fail('Choose an active person from your team');
  await assertShareable(db, siteId, orgOf(actor), sharedWith);
  const attachments = files.length ? await store(files) : [];
  const { rows: [created] } = await db.query(`WITH c AS (
      INSERT INTO complaints (site_id, raised_by, assigned_to, title, description, about_type, about_user_id, about_module, priority, attachments, kind, shared_with)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12::int[]) RETURNING id
    ) INSERT INTO complaint_events (complaint_id, actor_id, kind, status, assigned_to)
      SELECT id, $2, 'created', 'open', $3 FROM c RETURNING complaint_id AS id`,
  [siteId, actor.id, assignedTo, title, description, aboutType, aboutUserId, aboutModule, priority, JSON.stringify(attachments), kind, sharedWith]);
  return getComplaint(actor, created.id, db);
}

// The caller has read the complaint and checked the rule; the write is guarded
// on the status and assignee it read, so two people acting at once cannot both
// win (the second gets a 409). The event row is written in the same statement.
async function guardedChange(actor, complaint, db, setSql, value, event) {
  const { rows } = await db.query(`WITH changed AS (
      UPDATE complaints SET ${setSql}, updated_at = now() WHERE id = $1 AND status = $2 AND assigned_to = $3 RETURNING id
    ) INSERT INTO complaint_events (complaint_id, actor_id, kind, status, assigned_to, note)
      SELECT id, $4::int, $5::text, $6::text, $7::int, $8::text FROM changed RETURNING id`,
  [complaint.id, complaint.status, complaint.assigned_to, actor.id, event.kind, event.status ?? null,
    event.assigned_to ?? null, event.note ?? null, value]);
  if (!rows[0]) throw fail('This complaint just changed. Refresh and try again.', 409);
  try {
    return await getComplaint(actor, complaint.id, db);
  } catch (error) {
    if (error.statusCode !== 404) throw error;
    // The actor just handed it to someone else and lost sight of it: return the
    // row they changed once, flagged, so the page can drop it.
    const { rows: [row] } = await db.query(`${ROW_SQL} WHERE c.id = $1`, [complaint.id, actor.id]);
    return { ...publicRow(row, actor), hidden: true };
  }
}

export async function changeComplaintStatus(actor, rawId, body = {}, db = pool) {
  const status = String(body.status || '');
  if (!Object.hasOwn(TRANSITIONS, status)) throw fail('Unknown status');
  const note = cleanText(body.note, 2000, 'Note');
  if (NOTE_REQUIRED[status] && !note) throw fail(NOTE_REQUIRED[status]);
  const complaint = await getComplaint(actor, rawId, db);
  if (complaint.status === status) throw fail(`This complaint is already ${status.replace('_', ' ')}`, 409);
  if (!complaint.statuses.includes(status)) throw fail('You cannot make this change', 403);
  return guardedChange(actor, complaint, db,
    `status = $9::text, resolved_at = CASE WHEN $9::text IN ('resolved', 'closed') THEN now() ELSE NULL END`, status,
    { kind: 'status', status, note });
}

/** The raiser (or an admin) changes who else may see it; trail keeps a 'shared' event. */
export async function shareComplaint(actor, rawId, body = {}, db = pool) {
  const complaint = await getComplaint(actor, rawId, db);
  if (!isComplaintAdmin(actor) && Number(complaint.raised_by) !== Number(actor.id)) throw fail('Only the person who raised it or an admin can change who sees it', 403);
  const sharedWith = cleanShareList(body.shared_with, { self: Number(complaint.raised_by),
    assignedTo: Number(complaint.assigned_to), aboutUserId: complaint.about_user_id && Number(complaint.about_user_id) });
  await assertShareable(db, complaint.site_id, orgOf(actor), sharedWith);
  const { rows } = await db.query(`WITH changed AS (
      UPDATE complaints SET shared_with = $2::int[], updated_at = now() WHERE id = $1 RETURNING id
    ) INSERT INTO complaint_events (complaint_id, actor_id, kind) SELECT id, $3, 'shared' FROM changed RETURNING id`,
  [complaint.id, sharedWith, actor.id]);
  if (!rows[0]) throw fail('Complaint not found', 404);
  return getComplaint(actor, complaint.id, db);
}

export async function reassignComplaint(actor, rawId, body = {}, db = pool) {
  const assignedTo = positiveId(body.assigned_to, 'assignee');
  const note = cleanText(body.note, 2000, 'Note');
  const complaint = await getComplaint(actor, rawId, db);
  if (!complaint.can_reassign) throw fail('Only the assignee or an admin can reassign an active complaint', 403);
  if (Number(complaint.assigned_to) === assignedTo) throw fail('Already assigned to this person');
  if (Number(complaint.about_user_id) === assignedTo) throw fail("Don't assign a complaint to the person it is about");
  const { rows: [check] } = await db.query(`SELECT EXISTS (SELECT 1 FROM users u WHERE u.id = $2 AND u.organization_id = $3
    AND u.is_active AND ${ASSIGNABLE}) AS ok`, [complaint.site_id, assignedTo, orgOf(actor)]);
  if (!check.ok) throw fail('Assign it to an admin, or a sub-admin of this site');
  return guardedChange(actor, complaint, db, 'assigned_to = $9::int', assignedTo,
    { kind: 'assigned', assigned_to: assignedTo, note });
}

// Discussion: the same contract as Seek Permission comments, so the shared chat
// hook/UI drive both. Comment ids are keyset cursors; reads are a per-user watermark.
const COMMENT_SQL = `SELECT cc.id, cc.complaint_id AS request_id, cc.author_id, u.name AS author_name,
  u.role AS author_role, cc.body, cc.client_id, cc.created_at
  FROM complaint_comments cc JOIN users u ON u.id = cc.author_id`;
const commentMetadata = c => ({ comment_count: c.comment_count, unread_comments: c.unread_comments, last_comment_at: c.last_comment_at });

export async function listComplaintComments(actor, rawId, query = {}, db = pool) {
  const complaint = await getComplaint(actor, rawId, db);
  const hasBefore = query.before_id !== undefined && query.before_id !== '';
  const hasAfter = query.after_id !== undefined && query.after_id !== '';
  if (hasBefore && hasAfter) throw fail('Use before_id or after_id, not both');
  const cursor = hasAfter && String(query.after_id) === '0' ? 0
    : hasBefore || hasAfter ? positiveId(hasBefore ? query.before_id : query.after_id, 'comment cursor') : null;
  const limit = query.limit === undefined ? 40 : positiveId(query.limit, 'limit');
  if (limit > 100) throw fail('limit must be 100 or fewer');
  const { rows } = await db.query(`${COMMENT_SQL} WHERE cc.complaint_id = $1 AND ($2::int IS NULL OR cc.id ${hasAfter ? '>' : '<'} $2)
    ORDER BY cc.id ${hasAfter ? 'ASC' : 'DESC'} LIMIT $3`, [complaint.id, cursor, limit + 1]);
  const hasMore = rows.length > limit;
  const comments = rows.slice(0, limit);
  if (!hasAfter) comments.reverse();
  return { comments, has_more: hasMore, next_before_id: comments[0]?.id ?? null,
    last_comment_id: comments.at(-1)?.id ?? null, ...commentMetadata(complaint) };
}

const cleanComment = body => {
  if (typeof body !== 'string') throw fail('Write a comment');
  const text = body.replace(/\r\n?/g, '\n').trim();
  if (!text) throw fail('Write a comment');
  if (text.length > 4000) throw fail('Comment must be 4000 characters or fewer');
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) throw fail('Comment contains unsupported characters');
  return text;
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Idempotent per (author, client_id): a retried send never duplicates a message. */
export async function createComplaintComment(actor, rawId, body = {}, db = pool) {
  const text = cleanComment(body.body);
  if (typeof body.client_id !== 'string' || !UUID.test(body.client_id)) throw fail('A valid client_id UUID is required');
  const clientId = body.client_id.toLowerCase();
  const complaint = await getComplaint(actor, rawId, db);
  // Lock the complaint before the INSERT takes its SERIAL id, so concurrent
  // replies commit in thread order and a read cursor never skips one.
  const { rows: [inserted] } = await db.query(`WITH locked AS MATERIALIZED (SELECT id FROM complaints WHERE id = $1 FOR UPDATE)
    INSERT INTO complaint_comments (complaint_id, author_id, body, client_id) SELECT id, $2, $3, $4::uuid FROM locked
    ON CONFLICT (complaint_id, author_id, client_id) DO NOTHING RETURNING id`, [complaint.id, actor.id, text, clientId]);
  const [fresh, { rows: [comment] }] = await Promise.all([
    getComplaint(actor, complaint.id, db),
    db.query(`${COMMENT_SQL} WHERE cc.complaint_id = $1 AND cc.author_id = $2 AND cc.client_id = $3::uuid`, [complaint.id, actor.id, clientId]),
  ]);
  if (!comment) throw fail('Unable to send comment. Please try again.', 503);
  if (comment.body !== text) throw fail('This client_id was already used for another comment', 409);
  return { comment, created: Boolean(inserted), complaint: fresh, ...commentMetadata(fresh) };
}

export async function markComplaintCommentsSeen(actor, rawId, body = {}, db = pool) {
  const complaint = await getComplaint(actor, rawId, db);
  const lastId = String(body.last_comment_id) === '0' ? 0 : positiveId(body.last_comment_id, 'last_comment_id');
  // Only a real id from this thread; a slower tab never moves the watermark back.
  const { rows: [seen] } = await db.query(`INSERT INTO complaint_comment_reads (complaint_id, user_id, last_comment_id)
    SELECT $1, $2, $3 WHERE $3 = 0 OR EXISTS (SELECT 1 FROM complaint_comments WHERE complaint_id = $1 AND id = $3)
    ON CONFLICT (complaint_id, user_id) DO UPDATE
      SET last_comment_id = GREATEST(complaint_comment_reads.last_comment_id, EXCLUDED.last_comment_id), seen_at = now()
    RETURNING last_comment_id`, [complaint.id, actor.id, lastId]);
  if (!seen) throw fail('last_comment_id must identify a comment in this complaint');
  const updated = await getComplaint(actor, complaint.id, db);
  return { last_comment_id: seen.last_comment_id, ...commentMetadata(updated) };
}

/**
 * Header bell + Notifications page. Received: visible, raised by someone else,
 * and active or with unread replies. Sent: my own, attention first.
 */
export async function complaintInbox(actor, { site_id } = {}, db = pool) {
  requireActor(actor);
  const { rows: [inbox] } = await db.query(`WITH entries AS (${ROW_SQL} ${visibleWhere('c.site_id')}),
      received AS (SELECT * FROM entries WHERE raised_by <> $2 AND (status IN ('open', 'in_progress') OR unread_comments > 0)),
      sent AS (SELECT * FROM entries WHERE raised_by = $2)
    SELECT COALESCE((SELECT json_agg(r) FROM (SELECT * FROM received ORDER BY updated_at DESC, id DESC LIMIT 200) r), '[]'::json) AS received,
      COALESCE((SELECT json_agg(r) FROM (SELECT * FROM sent ORDER BY (unread_comments > 0 OR status IN ('open', 'in_progress')) DESC,
        updated_at DESC, id DESC LIMIT 50) r), '[]'::json) AS sent,
      (SELECT count(*)::int FROM received) AS received_count,
      (SELECT count(*)::int FROM sent WHERE unread_comments > 0) AS sent_attention_count`,
  params(actor, positiveId(site_id, 'site_id')));
  return { ...inbox, received: inbox.received.map(row => publicRow(row, actor)), sent: inbox.sent.map(row => publicRow(row, actor)) };
}

export async function complaintAttachmentFile(actor, rawId, rawIndex, db = pool) {
  if (!/^\d+$/.test(String(rawIndex))) throw fail('Attachment not found', 404);
  const { rows: [row] } = await db.query(`SELECT c.attachments FROM complaints c JOIN sites s ON s.id = c.site_id
    LEFT JOIN complaint_access a ON a.site_id = c.site_id AND a.user_id = $2 ${visibleWhere('c.id')}`,
  params(actor, positiveId(rawId, 'complaint id')));
  const file = row?.attachments?.[Number(rawIndex)];
  if (!file?.url) throw fail('Attachment not found', 404);
  return file;
}

/** A fresh signed link to one attachment, for anyone who can see the complaint. */
export async function complaintAttachmentUrl(actor, rawId, rawIndex, db = pool, sign = signFile) {
  const file = await complaintAttachmentFile(actor, rawId, rawIndex, db);
  const url = await sign(file.url);
  if (!url) throw fail('Attachment not found', 404);
  return { url, name: file.name, type: file.type };
}

/** Everyone whose page shows this complaint — the same rule as the list, per user. */
export async function complaintRecipients(complaintId, db = pool) {
  const { rows } = await db.query(`SELECT u.id FROM complaints c JOIN sites s ON s.id = c.site_id
    JOIN users u ON u.organization_id = s.organization_id AND u.is_active AND u.role IN ('admin', 'super_admin', 'sub_admin')
    LEFT JOIN complaint_access a ON a.site_id = c.site_id AND a.user_id = u.id
    WHERE c.id = $1 AND ${visibleTo({ id: 'u.id', admin: "(u.role IN ('admin', 'super_admin'))" })}`, [complaintId]);
  return rows.map(row => row.id);
}

// Studio: every active sub-admin assigned to the site, with their visibility.
const SITE_PEOPLE_SQL = `SELECT u.id, u.name FROM users u
  JOIN user_sites us ON us.user_id = u.id AND us.site_id = $1
  JOIN sites s ON s.id = us.site_id AND s.organization_id = $2
  WHERE u.organization_id = $2 AND u.is_active AND u.role = 'sub_admin'`;

const requireAdmin = actor => { if (!isComplaintAdmin(actor)) throw fail('Only admins can do this', 403); };

export async function listComplaintAccess(actor, { site_id } = {}, db = pool) {
  requireAdmin(actor);
  const { rows } = await db.query(`SELECT p.id, p.name, COALESCE(a.scope, 'own') AS scope,
      COALESCE(a.visible_user_ids, '{}') AS user_ids
    FROM (${SITE_PEOPLE_SQL}) p LEFT JOIN complaint_access a ON a.site_id = $1 AND a.user_id = p.id
    ORDER BY lower(p.name), p.id`, [positiveId(site_id, 'site_id'), orgOf(actor)]);
  return rows;
}

export async function setComplaintAccess(actor, rawUserId, body = {}, db = pool) {
  requireAdmin(actor);
  const siteId = positiveId(body.site_id, 'site_id');
  const userId = positiveId(rawUserId, 'user');
  if (!SCOPES.includes(body.scope)) throw fail('scope must be own, all or selected');
  const ids = body.scope === 'selected'
    ? [...new Set((Array.isArray(body.user_ids) ? body.user_ids : []).map(value => positiveId(value, 'user')))].filter(id => id !== userId)
    : [];
  // Both the viewer and the people they may follow must be sub-admins of this site.
  const { rows: [saved] } = await db.query(`WITH people AS (${SITE_PEOPLE_SQL})
    INSERT INTO complaint_access (site_id, user_id, scope, visible_user_ids, updated_by)
    SELECT $1, $3, $4, ARRAY(SELECT id FROM people WHERE id = ANY($5::int[]) ORDER BY id), $6
     WHERE EXISTS (SELECT 1 FROM people WHERE id = $3)
    ON CONFLICT (site_id, user_id) DO UPDATE SET scope = EXCLUDED.scope,
      visible_user_ids = EXCLUDED.visible_user_ids, updated_by = EXCLUDED.updated_by, updated_at = now()
    RETURNING user_id AS id, scope, visible_user_ids AS user_ids`, [siteId, orgOf(actor), userId, body.scope, ids, actor.id]);
  if (!saved) throw fail('Active sub-admin assigned to this site not found', 404);
  return saved;
}
