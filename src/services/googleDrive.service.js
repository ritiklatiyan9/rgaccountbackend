import { Readable } from 'node:stream';
import { google } from 'googleapis';
import pool from '../config/db.js';
import { encrypt, decrypt } from '../utils/tokenCrypto.js';
import { buildOAuthClient } from './googleCalendarSync.service.js';
import { safeFilePart } from './yearEndDocuments.service.js';

/**
 * Google Drive plumbing shared by the settings page and every module that
 * shares records: one OAuth-connected Drive per organization, a root folder
 * the CA is granted access to, a cached folder tree beneath it, and
 * create-or-update file uploads. Domain code (what to upload) lives in the
 * per-module share services.
 */

export const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
// drive.file only reaches files this app created — the least-privilege Drive
// scope; openid+email just tell us which Google account was connected.
export const DRIVE_SCOPES = ['openid', 'email', DRIVE_FILE_SCOPE];
export const MODULE_ROOT_NAME = 'Defence Garden Accounts';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const FILE_FIELDS = 'id,name,webViewLink,mimeType';
// Multipart bodies are capped at 5 MB by Drive; anything bigger goes resumable.
const MULTIPART_MAX_BYTES = 4.5 * 1024 * 1024;

export const isDriveConfigured = () =>
  Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET
    && process.env.GOOGLE_REDIRECT_URI && process.env.CALENDAR_TOKEN_ENC_KEY);

const IST_DATE = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Kolkata', day: '2-digit', month: '2-digit', year: 'numeric',
});
export const istDateFolder = (date = new Date()) => IST_DATE.format(date).replaceAll('/', '-');

// Drive query strings are single-quoted; backslash first so the quote escape
// is not itself re-escaped.
export const escapeDriveQuery = (s) => String(s ?? '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
export const folderPathKey = (segments) => segments.filter(Boolean).join('/');
/** Drive name of a site's folder; a slash in the site name must not become a
 * level, and a nameless site gets its own folder rather than safeFilePart's
 * shared 'Unassigned'. */
export const siteFolderName = (site) => (String(site?.name || '').trim() ? safeFilePart(site.name) : `Site ${site?.id}`);
export const folderUrl = (id) => `https://drive.google.com/drive/folders/${id}`;
export const fileUrl = (file) => file?.webViewLink || `https://drive.google.com/file/d/${file?.id}/view`;

export const getDriveConnection = async (orgId) => {
  const { rows } = await pool.query(
    `SELECT id, google_account_email, status, scope, root_folder_id, root_folder_name,
            connected_by, created_at, updated_at
       FROM google_drive_connections
      WHERE organization_id=$1 ORDER BY updated_at DESC LIMIT 1`,
    [orgId],
  );
  return rows[0] || null;
};

export const markReauthorizationRequired = (orgId) => pool.query(
  `UPDATE google_drive_connections SET status='reauthorization_required', updated_at=NOW()
    WHERE organization_id=$1 AND status='active'`,
  [orgId],
);

/** Authenticated Drive client for the org, or null when not connected. */
export const driveClientFor = async (orgId) => {
  if (!isDriveConfigured()) return null;
  const { rows } = await pool.query(
    `SELECT id, organization_id, google_account_email, access_token_enc, refresh_token_enc,
            token_expiry, root_folder_id, root_folder_name, status
       FROM google_drive_connections
      WHERE organization_id=$1 AND status='active' LIMIT 1`,
    [orgId],
  );
  const connection = rows[0];
  if (!connection) return null;

  const auth = buildOAuthClient();
  auth.setCredentials({
    access_token: decrypt(connection.access_token_enc),
    refresh_token: decrypt(connection.refresh_token_enc),
    expiry_date: connection.token_expiry ? new Date(connection.token_expiry).getTime() : undefined,
  });
  auth.on('tokens', (tokens) => {
    if (!tokens.access_token) return;
    pool.query(
      `UPDATE google_drive_connections
          SET access_token_enc=$1, token_expiry=$2, updated_at=NOW()
        WHERE id=$3`,
      [encrypt(tokens.access_token), tokens.expiry_date ? new Date(tokens.expiry_date) : null, connection.id],
    ).catch((err) => console.error('[gdrive] failed to persist refreshed token:', err.message));
  });
  return { drive: google.drive({ version: 'v3', auth }), auth, connection, orgId };
};

// ---------------------------------------------------------------------------
// Locks

/** Serialises folder creation per org so concurrent shares never race two
 * folders with the same name. Session-level lock on a dedicated client, which
 * is handed to `fn` so the holder's own SQL never waits on a second pool slot. */
export const withOrgFolderLock = async (orgId, fn) => {
  const client = await pool.connect();
  const key = `gdrive-folders:${orgId}`;
  try {
    await client.query('SELECT pg_advisory_lock(hashtext($1))', [key]);
    try {
      return await fn(client);
    } finally {
      await client.query('SELECT pg_advisory_unlock(hashtext($1))', [key]);
    }
  } finally {
    client.release();
  }
};

/** Non-blocking per-plot lock: `{ release }` when acquired, null when a share
 * for that plot is already running. */
export const tryPlotShareLock = async (orgId, plotId) => {
  const client = await pool.connect();
  const key = `gdrive-share:${orgId}:${plotId}`;
  try {
    const { rows } = await client.query('SELECT pg_try_advisory_lock(hashtext($1)) AS ok', [key]);
    if (!rows[0]?.ok) {
      client.release();
      return null;
    }
  } catch (err) {
    client.release();
    throw err;
  }
  return {
    release: async () => {
      try {
        await client.query('SELECT pg_advisory_unlock(hashtext($1))', [key]);
      } finally {
        client.release();
      }
    },
  };
};

// ---------------------------------------------------------------------------
// Folders

// gaxios errors carry the HTTP status in `status`/`response.status`; `code` is
// only set for transport-level failures.
const httpStatus = (err) => err?.status ?? err?.response?.status;
const isNotFound = (err) => httpStatus(err) === 404;

// Drive marks every descendant of a trashed folder as trashed, so checking the
// deepest folder of a path covers its ancestors too.
const folderAlive = async (ctx, folderId) => {
  try {
    const { data } = await ctx.drive.files.get({ fileId: folderId, fields: 'id,trashed' });
    return !data.trashed;
  } catch (err) {
    if (isNotFound(err)) return false;
    throw err;
  }
};

const findOrCreateFolder = async (ctx, parentId, name) => {
  const { data } = await ctx.drive.files.list({
    q: `name = '${escapeDriveQuery(name)}' and '${escapeDriveQuery(parentId)}' in parents`
      + ` and mimeType = '${FOLDER_MIME}' and trashed = false`,
    fields: 'files(id)',
    pageSize: 1,
    spaces: 'drive',
  });
  if (data.files?.[0]) return data.files[0].id;
  const created = await ctx.drive.files.create({
    requestBody: { name, parents: [parentId], mimeType: FOLDER_MIME },
    fields: 'id',
  });
  return created.data.id;
};

const ensureRootFolderUnlocked = async (ctx, db) => {
  const { connection } = ctx;
  if (connection.root_folder_id && await folderAlive(ctx, connection.root_folder_id)) {
    return connection.root_folder_id;
  }
  const rootId = await findOrCreateFolder(ctx, 'root', connection.root_folder_name || MODULE_ROOT_NAME);
  await db.query(
    'UPDATE google_drive_connections SET root_folder_id=$1, updated_at=NOW() WHERE id=$2',
    [rootId, connection.id],
  );
  connection.root_folder_id = rootId;
  return rootId;
};

/** Root folder id, creating it in My Drive when missing or trashed. */
export const ensureRootFolder = (ctx) => withOrgFolderLock(ctx.orgId, (db) => ensureRootFolderUnlocked(ctx, db));

/** Folder id of the deepest segment, creating levels as needed. `base` is the
 * folder to start from (default: the root) with the cache-key prefix its
 * children are filed under, e.g. a site folder `{ id, key: 'site:10' }`. */
export const ensureFolderPath = (ctx, segments, { base } = {}) => withOrgFolderLock(ctx.orgId, async (db) => {
  const rootId = await ensureRootFolderUnlocked(ctx, db);
  const start = base || { id: rootId, key: '' };
  const prefixes = segments.map((_, i) => folderPathKey([start.key, ...segments.slice(0, i + 1)]));
  const { rows } = await db.query(
    `SELECT path, folder_id FROM google_drive_folders
      WHERE organization_id=$1 AND root_folder_id=$2 AND path = ANY($3::text[])`,
    [ctx.orgId, rootId, prefixes],
  );
  const cached = new Map(rows.map((r) => [r.path, r.folder_id]));

  let depth = prefixes.length;
  while (depth > 0 && !cached.has(prefixes[depth - 1])) depth -= 1;
  if (depth > 0 && !await folderAlive(ctx, cached.get(prefixes[depth - 1]))) {
    // Stale cache: drop the subtree and rebuild every level from the root
    // (ancestors are re-resolved by name, so a trashed parent is replaced too).
    await db.query(
      `DELETE FROM google_drive_folders
        WHERE organization_id=$1 AND root_folder_id=$2 AND (path = $3 OR starts_with(path, $3 || '/'))`,
      [ctx.orgId, rootId, prefixes[depth - 1]],
    );
    depth = 0;
  }

  let parentId = depth > 0 ? cached.get(prefixes[depth - 1]) : start.id;
  for (let i = depth; i < segments.length; i += 1) {
    parentId = await findOrCreateFolder(ctx, parentId, segments[i]);
    await db.query(
      `INSERT INTO google_drive_folders (organization_id, root_folder_id, path, folder_id)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (organization_id, root_folder_id, path) DO UPDATE SET folder_id=EXCLUDED.folder_id`,
      [ctx.orgId, rootId, prefixes[i], parentId],
    );
  }
  return parentId;
});

// ---------------------------------------------------------------------------
// Site folders — one per site under the root; the site's CA is granted here.

const siteKey = (siteId) => `site:${siteId}`;

/** Grants on a recreated site folder: the old folder's permissions died with it. */
const regrantSiteAccess = async (ctx, db, siteId, folderId) => {
  const { rows } = await db.query(
    'SELECT id, email, role FROM google_drive_access_emails WHERE organization_id=$1 AND site_id=$2',
    [ctx.orgId, siteId],
  );
  for (const row of rows) {
    try {
      const permissionId = await grantAccess(ctx, { fileId: folderId, email: row.email, role: row.role });
      await db.query('UPDATE google_drive_access_emails SET drive_permission_id=$1 WHERE id=$2', [permissionId, row.id]);
    } catch (err) {
      console.error(`[gdrive] could not re-grant ${row.email} on site ${siteId}:`, err.message);
    }
  }
};

/**
 * The site's folder `{ id, name, key }`, created under the root when missing or
 * trashed. A site renamed in the app is renamed in Drive too, so the CA's grant
 * (which is attached to this folder id) keeps covering every later share.
 */
export const ensureSiteFolder = (ctx, site) => withOrgFolderLock(ctx.orgId, async (db) => {
  const rootId = await ensureRootFolderUnlocked(ctx, db);
  const name = siteFolderName(site);
  const key = siteKey(site.id);
  const { rows } = await db.query(
    `SELECT id, folder_id, folder_name FROM google_drive_site_folders
      WHERE organization_id=$1 AND root_folder_id=$2 AND site_id=$3`,
    [ctx.orgId, rootId, site.id],
  );
  const row = rows[0];
  if (row && await folderAlive(ctx, row.folder_id)) {
    if (row.folder_name !== name) {
      await ctx.drive.files.update({ fileId: row.folder_id, requestBody: { name }, fields: 'id' });
      await db.query('UPDATE google_drive_site_folders SET folder_name=$1, updated_at=NOW() WHERE id=$2', [name, row.id]);
    }
    return { id: row.folder_id, name, key };
  }
  const folderId = await findOrCreateFolder(ctx, rootId, name);
  await db.query(
    `INSERT INTO google_drive_site_folders (organization_id, site_id, root_folder_id, folder_id, folder_name)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (organization_id, root_folder_id, site_id)
     DO UPDATE SET folder_id=EXCLUDED.folder_id, folder_name=EXCLUDED.folder_name, updated_at=NOW()`,
    [ctx.orgId, site.id, rootId, folderId, name],
  );
  // Children cached under the old folder went to the trash with it.
  await db.query(
    `DELETE FROM google_drive_folders
      WHERE organization_id=$1 AND root_folder_id=$2 AND (path = $3 OR starts_with(path, $3 || '/'))`,
    [ctx.orgId, rootId, key],
  );
  if (row) await regrantSiteAccess(ctx, db, site.id, folderId);
  return { id: folderId, name, key };
});

/** Site folder id/name from the registry only (no Drive calls); null when never created. */
export const getSiteFolder = async (ctx, siteId) => {
  if (!ctx.connection.root_folder_id) return null;
  const { rows } = await pool.query(
    `SELECT folder_id AS id, folder_name AS name FROM google_drive_site_folders
      WHERE organization_id=$1 AND root_folder_id=$2 AND site_id=$3`,
    [ctx.orgId, ctx.connection.root_folder_id, siteId],
  );
  return rows[0] ? { ...rows[0], key: siteKey(siteId) } : null;
};

// ---------------------------------------------------------------------------
// Files

const toFileResult = (file, created) => ({ id: file.id, name: file.name, url: fileUrl(file), mime_type: file.mimeType, created });

// Resumable sessions go through the OAuth client directly: googleapis' typed
// client only does multipart/media uploads.
const resumableUpload = async (ctx, { fileId, name, parentId, mimeType, convertTo, buf }) => {
  const base = 'https://www.googleapis.com/upload/drive/v3/files';
  const init = await ctx.auth.request({
    url: `${base}${fileId ? `/${fileId}` : ''}?uploadType=resumable&fields=${FILE_FIELDS}`,
    method: fileId ? 'PATCH' : 'POST',
    headers: {
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Type': mimeType,
      'X-Upload-Content-Length': String(buf.length),
    },
    data: fileId ? {} : { name, parents: [parentId], ...(convertTo ? { mimeType: convertTo } : {}) },
  });
  // google-auth-library 10 ships gaxios 7 (fetch Headers); the top-level
  // gaxios 6 used by googleapis exposes a plain object.
  const location = init.headers?.get?.('location') ?? init.headers?.location;
  const { data } = await ctx.auth.request({
    url: location,
    method: 'PUT',
    headers: { 'Content-Type': mimeType },
    data: buf,
    responseType: 'json',
  });
  return data;
};

/**
 * Create-or-update a file by name inside a folder. Re-sharing the same record
 * therefore refreshes the files in place instead of piling up copies.
 * `convertTo` is the Google mime type to import into (e.g. a Google Doc).
 * The result's `created` tells callers whether the file existed before.
 */
export const upsertFile = async (ctx, { parentId, name, mimeType, body, convertTo }) => {
  const { drive } = ctx;
  const { data } = await drive.files.list({
    q: `name = '${escapeDriveQuery(name)}' and '${escapeDriveQuery(parentId)}' in parents and trashed = false`,
    fields: 'files(id,name,mimeType)',
    pageSize: 1,
    spaces: 'drive',
  });
  const existing = data.files?.[0] || null;
  const size = Buffer.isBuffer(body) ? body.length : typeof body === 'string' ? Buffer.byteLength(body) : null;

  if (size != null && size > MULTIPART_MAX_BYTES) {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
    return toFileResult(await resumableUpload(ctx, {
      fileId: existing?.id, name, parentId, mimeType, convertTo, buf,
    }), !existing);
  }

  // googleapis multipart accepts a string or a Readable, never a Buffer.
  const stream = Buffer.isBuffer(body) || typeof body === 'string' ? Readable.from([body]) : body;
  const res = existing
    ? await drive.files.update({ fileId: existing.id, media: { mimeType, body: stream }, fields: FILE_FIELDS })
    : await drive.files.create({
      requestBody: { name, parents: [parentId], ...(convertTo ? { mimeType: convertTo } : {}) },
      media: { mimeType, body: stream },
      fields: FILE_FIELDS,
    });
  return toFileResult(res.data, !existing);
};

export const exportPdf = async (ctx, fileId) => {
  const res = await ctx.drive.files.export({ fileId, mimeType: 'application/pdf' }, { responseType: 'arraybuffer' });
  return Buffer.from(res.data);
};

// ---------------------------------------------------------------------------
// Folder permissions (children inherit them) — granted per site folder, or on
// the root for org-wide access.

export const grantAccess = async (ctx, { fileId, email, role }) => {
  const { data } = await ctx.drive.permissions.create({
    fileId,
    requestBody: { type: 'user', role, emailAddress: email },
    sendNotificationEmail: true,
    emailMessage: 'Defence Garden Accounts shares accounting records with you in this folder.',
    fields: 'id',
  });
  return data.id;
};

export const updateAccess = (ctx, { fileId, permissionId, role }) => ctx.drive.permissions.update({
  fileId,
  permissionId,
  requestBody: { role },
});

export const revokeAccess = async (ctx, { fileId, permissionId }) => {
  try {
    await ctx.drive.permissions.delete({ fileId, permissionId });
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }
};

// ---------------------------------------------------------------------------
// Errors

const isGrantExpired = (err) =>
  err?.response?.data?.error === 'invalid_grant' || /invalid_grant/.test(String(err?.message || ''));

const REAUTH = {
  statusCode: 409,
  code: 'GOOGLE_DRIVE_REAUTH',
  message: 'Google Drive access expired. Reconnect Google Drive in Settings (if the Google app is still in Testing mode, tokens expire every 7 days).',
};

/** Maps Google / pg failures to the `{ statusCode, message, code }` the UI expects. */
export const translateDriveError = (err) => {
  const reason = err?.errors?.[0]?.reason || err?.response?.data?.error?.errors?.[0]?.reason;
  if (isGrantExpired(err)) return REAUTH;
  if (reason === 'accessNotConfigured') {
    return { statusCode: 503, code: 'GOOGLE_DRIVE_API_DISABLED', message: 'Enable the Google Drive API for this Google Cloud project' };
  }
  if (['insufficientPermissions', 'forbidden', 'appNotAuthorizedToFile'].includes(reason)) return REAUTH;
  if (reason === 'invalidSharingRequest') {
    return { statusCode: 400, code: 'NOT_A_GOOGLE_ACCOUNT', message: 'This email is not a Google account. Ask your CA for the Gmail / Google Workspace address they use with Drive.' };
  }
  if (reason === 'storageQuotaExceeded') {
    return { statusCode: 507, code: 'GOOGLE_DRIVE_QUOTA', message: 'The connected Google Drive is out of storage space' };
  }
  if (isNotFound(err)) return { statusCode: 404, code: 'GOOGLE_DRIVE_NOT_FOUND', message: 'The Google Drive file or folder no longer exists' };
  if (err?.code === '42P01') {
    return { statusCode: 503, code: 'GOOGLE_DRIVE_NOT_READY', message: 'Google Drive sharing database update is required' };
  }
  return { statusCode: 502, code: 'GOOGLE_DRIVE_FAILED', message: 'Google Drive request failed' };
};

/** Answers a Drive/DB failure directly — the error middleware would hide any
 * 5xx behind a generic message. */
export const sendDriveError = (res, err) => {
  console.error('[gdrive]', err);
  const { statusCode, message, code } = translateDriveError(err);
  const orgId = res.req?.user?.organization_id;
  if (isGrantExpired(err) && orgId) {
    markReauthorizationRequired(orgId).catch((e) => console.error('[gdrive] failed to flag reauthorization:', e.message));
  }
  res.status(statusCode).json({ message, code });
};
