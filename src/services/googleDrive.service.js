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
const UPLOAD_CHUNK_BYTES = 64 * 1024;

// A context belongs to one request/job. Never retain Drive liveness across
// jobs: folders may be moved or deleted by the account owner between shares.
const folderStates = new WeakMap();
const folderState = (ctx) => {
  if (!folderStates.has(ctx)) folderStates.set(ctx, { alive: new Set(), parents: new Map(), repairs: new Map(), redirects: new Map(), recovering: new Map() });
  return folderStates.get(ctx);
};
const currentFolderId = (ctx, id) => {
  const { redirects } = folderState(ctx);
  while (redirects.has(id)) id = redirects.get(id);
  return id;
};
const rememberFolder = (ctx, id, repair) => {
  const state = folderState(ctx);
  state.alive.add(id);
  if (repair) state.repairs.set(id, repair);
  return id;
};
const repairFolder = async (ctx, staleId) => {
  const state = folderState(ctx);
  const id = currentFolderId(ctx, staleId);
  const repair = state.repairs.get(id);
  if (!repair) return id;
  if (state.recovering.has(id)) return state.recovering.get(id);
  // A missing descendant may mean its entire site/root was trashed.
  state.alive.clear();
  const pending = Promise.resolve().then(repair).then((freshId) => {
    if (freshId !== id) {
      // A user may have restored an older folder since the last repair.
      state.redirects.delete(freshId);
      state.redirects.set(id, freshId);
    }
    return freshId;
  }).finally(() => state.recovering.delete(id));
  state.recovering.set(id, pending);
  return pending;
};

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
 * folders with the same name. An explicit transaction pins one server session
 * through PgBouncer/Neon transaction pooling. Session-level advisory locks
 * would leak when the following unlock query lands on a different backend.
 * `fn` receives this client so its SQL does not need a second pool slot. */
export const withOrgFolderLock = async (orgId, fn) => {
  const client = await pool.connect();
  const key = `gdrive-folders:${orgId}`;
  let discard;
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '10s'");
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [key]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (cleanupError) { discard = cleanupError; }
    if (err?.code === '55P03') {
      throw Object.assign(new Error('Google Drive folder preparation is busy. Retry the share in a few seconds.'), {
        code: 'GOOGLE_DRIVE_BUSY', cause: err,
      });
    }
    throw err;
  } finally {
    // If rollback failed, destroy this client instead of pooling an open tx.
    client.release(discard);
  }
};

/** Non-blocking per-plot lock: `{ release }` when acquired, null when a share
 * for that plot is already running. */
export const tryPlotShareLock = async (orgId, plotId) => {
  const client = await pool.connect();
  const key = `gdrive-share:${orgId}:${plotId}`;
  let handedOff = false;
  let discard;
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT pg_try_advisory_xact_lock(hashtext($1)) AS ok', [key]);
    if (!rows[0]?.ok) {
      await client.query('ROLLBACK');
      return null;
    }
    handedOff = true;
    let releasePromise;
    return {
      release: () => {
        // Release is idempotent, even when cleanup is requested concurrently.
        if (!releasePromise) releasePromise = (async () => {
          let releaseError;
          try {
            await client.query('COMMIT');
          } catch (err) {
            try { await client.query('ROLLBACK'); } catch (cleanupError) { releaseError = cleanupError; }
            throw err;
          } finally {
            client.release(releaseError);
          }
        })();
        return releasePromise;
      },
    };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (cleanupError) { discard = cleanupError; }
    throw err;
  } finally {
    if (!handedOff) client.release(discard);
  }
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
  const { alive } = folderState(ctx);
  if (alive.has(folderId)) return true;
  try {
    const { data } = await ctx.drive.files.get({ fileId: folderId, fields: 'id,trashed,parents' });
    folderState(ctx).parents.set(folderId, data.parents || []);
    if (!data.trashed) { alive.add(folderId); return true; }
    alive.delete(folderId);
    return false;
  } catch (err) {
    if (isNotFound(err)) { alive.delete(folderId); return false; }
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
  if (data.files?.[0]) return rememberFolder(ctx, data.files[0].id);
  const created = await ctx.drive.files.create({
    requestBody: { name, parents: [parentId], mimeType: FOLDER_MIME },
    fields: 'id',
  });
  return rememberFolder(ctx, created.data.id);
};

const ensureRootFolderUnlocked = async (ctx, db) => {
  const { connection } = ctx;
  if (connection.root_folder_id && await folderAlive(ctx, connection.root_folder_id)) {
    return rememberFolder(ctx, connection.root_folder_id, () => ensureRootFolder(ctx));
  }
  const rootId = await findOrCreateFolder(ctx, 'root', connection.root_folder_name || MODULE_ROOT_NAME);
  await db.query(
    'UPDATE google_drive_connections SET root_folder_id=$1, updated_at=NOW() WHERE id=$2',
    [rootId, connection.id],
  );
  connection.root_folder_id = rootId;
  return rememberFolder(ctx, rootId, () => ensureRootFolder(ctx));
};

/** Root folder id, creating it in My Drive when missing or trashed. */
export const ensureRootFolder = (ctx) => withOrgFolderLock(ctx.orgId, (db) => ensureRootFolderUnlocked(ctx, db));

/** Folder id of the deepest segment, creating levels as needed. `base` is the
 * folder to start from (default: the root) with the cache-key prefix its
 * children are filed under, e.g. a site folder `{ id, key: 'site:10' }`. */
export const ensureFolderPath = (ctx, segments, { base } = {}) => withOrgFolderLock(ctx.orgId, async (db) => {
  const rootId = await ensureRootFolderUnlocked(ctx, db);
  const start = base ? { ...base, id: currentFolderId(ctx, base.id) } : { id: rootId, key: '' };
  if (!segments.length) return start.id;
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
  return rememberFolder(ctx, parentId, async () => {
    const freshBase = base ? { ...base, id: await repairFolder(ctx, base.id) } : undefined;
    return ensureFolderPath(ctx, segments, { base: freshBase });
  });
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
    let permissionId;
    try {
      permissionId = await grantAccess(ctx, { fileId: folderId, email: row.email, role: row.role });
    } catch (err) {
      console.error(`[gdrive] could not re-grant ${row.email} on site ${siteId}:`, err.message);
      continue;
    }
    // SQL errors must abort the surrounding folder transaction. Swallowing
    // one here would make PostgreSQL silently roll back the later COMMIT.
    await db.query('UPDATE google_drive_access_emails SET drive_permission_id=$1 WHERE id=$2', [permissionId, row.id]);
  }
};

/**
 * The site's folder `{ id, name, key }`, created under the root when missing or
 * trashed. A site renamed in the app is renamed in Drive too, so the CA's grant
 * (which is attached to this folder id) keeps covering every later share.
 */
export const ensureSiteFolder = (ctx, site) => withOrgFolderLock(ctx.orgId, async (db) => {
  const name = siteFolderName(site);
  const key = siteKey(site.id);
  let rootId = ctx.connection.root_folder_id;
  const { rows } = rootId ? await db.query(
    `SELECT id, folder_id, folder_name FROM google_drive_site_folders
      WHERE organization_id=$1 AND root_folder_id=$2 AND site_id=$3`,
    [ctx.orgId, rootId, site.id],
  ) : { rows: [] };
  const row = rows[0];
  let liveSite = row && await folderAlive(ctx, row.folder_id);
  if (liveSite) {
    // A live descendant also proves its root is not trashed; skip the
    // separate root request on the common repeat-share path. A site moved by
    // its owner cannot prove anything about its former root.
    if (folderState(ctx).parents.get(row.folder_id)?.includes(rootId)) rememberFolder(ctx, rootId, () => ensureRootFolder(ctx));
    else liveSite = await ensureRootFolderUnlocked(ctx, db) === rootId;
  }
  if (liveSite) {
    if (row.folder_name !== name) {
      await ctx.drive.files.update({ fileId: row.folder_id, requestBody: { name }, fields: 'id' });
      await db.query('UPDATE google_drive_site_folders SET folder_name=$1, updated_at=NOW() WHERE id=$2', [name, row.id]);
    }
    return { id: rememberFolder(ctx, row.folder_id, async () => (await ensureSiteFolder(ctx, site)).id), name, key };
  }
  rootId = await ensureRootFolderUnlocked(ctx, db);
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
  // Grants are keyed by site, even if the old root/site registry is gone.
  await regrantSiteAccess(ctx, db, site.id, folderId);
  return { id: rememberFolder(ctx, folderId, async () => (await ensureSiteFolder(ctx, site)).id), name, key };
});

/** Sibling folders under `parent` in one go: one listing, then only the
 * missing ones are created. Returns name → folder id. */
export const ensureSubfolders = (ctx, parent, names) => withOrgFolderLock(ctx.orgId, async (db) => {
  const rootId = await ensureRootFolderUnlocked(ctx, db);
  parent = { ...parent, id: currentFolderId(ctx, parent.id) };
  names = [...new Set(names)];
  const keys = names.map((name) => folderPathKey([parent.key, name]));
  const { rows } = await db.query(
    `SELECT path, folder_id FROM google_drive_folders
      WHERE organization_id=$1 AND root_folder_id=$2 AND path = ANY($3::text[])`,
    [ctx.orgId, rootId, keys],
  );
  const cached = new Map(rows.map((r) => [r.path, r.folder_id]));
  const result = new Map();
  // DB cache entries are hints until validated in this job. Checking siblings
  // concurrently avoids both serial network waits and writes to trashed IDs.
  const validated = await Promise.allSettled(names.map(async (name, i) => {
    const id = cached.get(keys[i]);
    if (id && !await folderAlive(ctx, id)) {
      cached.delete(keys[i]);
      await db.query(
        `DELETE FROM google_drive_folders
          WHERE organization_id=$1 AND root_folder_id=$2 AND (path = $3 OR starts_with(path, $3 || '/'))`,
        [ctx.orgId, rootId, keys[i]],
      );
    }
  }));
  const invalid = validated.find((entry) => entry.status === 'rejected');
  if (invalid) throw invalid.reason;
  const missing = names.filter((name, i) => !cached.has(keys[i]));
  const rememberChild = (name, id) => {
    result.set(name, rememberFolder(ctx, id, async () => {
      const freshParent = { ...parent, id: await repairFolder(ctx, parent.id) };
      return (await ensureSubfolders(ctx, freshParent, [name])).get(name);
    }));
  };
  names.forEach((name, i) => { if (cached.has(keys[i])) rememberChild(name, cached.get(keys[i])); });
  if (!missing.length) return result;
  const children = await listChildrenRaw(ctx, parent.id);
  // All names are distinct and the org lock is still held until every create
  // settles, including when one fails. Do not release the lock mid-flight.
  const created = await Promise.allSettled(missing.map(async (name) => {
    const existing = children.get(name);
    const id = existing?.mimeType === FOLDER_MIME
      ? existing.id
      : (await ctx.drive.files.create({ requestBody: { name, parents: [parent.id], mimeType: FOLDER_MIME }, fields: 'id' })).data.id;
    await db.query(
      `INSERT INTO google_drive_folders (organization_id, root_folder_id, path, folder_id)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (organization_id, root_folder_id, path) DO UPDATE SET folder_id=EXCLUDED.folder_id`,
      [ctx.orgId, rootId, folderPathKey([parent.key, name]), id],
    );
    rememberChild(name, id);
  }));
  const failed = created.find((entry) => entry.status === 'rejected');
  if (failed) throw failed.reason;
  return result;
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

/** Everything directly inside a folder, keyed by name (app-created files only, as drive.file allows). */
const listChildrenRaw = async (ctx, parentId) => {
  const byName = new Map();
  let pageToken;
  do {
    const { data } = await ctx.drive.files.list({
      q: `'${escapeDriveQuery(parentId)}' in parents and trashed = false`,
      fields: 'nextPageToken,files(id,name,mimeType)',
      pageSize: 200,
      spaces: 'drive',
      pageToken,
    });
    for (const file of data.files || []) if (!byName.has(file.name)) byName.set(file.name, file);
    pageToken = data.nextPageToken;
  } while (pageToken);
  return byName;
};

export const listChildren = async (ctx, parentId) => {
  const id = currentFolderId(ctx, parentId);
  try { return await listChildrenRaw(ctx, id); } catch (err) {
    if (!isNotFound(err)) throw err;
    const freshId = await repairFolder(ctx, id);
    return listChildrenRaw(ctx, freshId);
  }
};

const toFileResult = (file, created) => ({ id: file.id, name: file.name, url: fileUrl(file), mime_type: file.mimeType, created });

// googleapis-common reports bytesRead for multipart creates, but media-only
// updates and gaxios resumable PUTs do not implement Node upload progress.
// Count the same payload bytes as the HTTP client consumes them for every
// transport. These are streamed bytes, not an acknowledgement from Drive.
const uploadStream = (body, onUploadProgress, size) => {
  const buf = Buffer.isBuffer(body) ? body : typeof body === 'string' ? Buffer.from(body) : null;
  if (!onUploadProgress) return buf ? Readable.from([buf]) : body;
  return Readable.from((async function* () {
    let bytesSent = 0;
    const chunks = buf ? (function* () {
      for (let offset = 0; offset < buf.length; offset += UPLOAD_CHUNK_BYTES) yield buf.subarray(offset, offset + UPLOAD_CHUNK_BYTES);
    }()) : body;
    for await (const chunk of chunks) {
      bytesSent += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk);
      // UI observers must not abort an otherwise valid accounting upload.
      try {
        const pending = onUploadProgress({ bytes_sent: bytesSent, bytes_total: size });
        if (pending?.catch) pending.catch(() => {});
      } catch { /* progress delivery is best effort */ }
      yield chunk;
    }
  }()));
};

// Resumable sessions go through the OAuth client directly: googleapis' typed
// client only does multipart/media uploads.
const resumableUpload = async (ctx, { fileId, name, parentId, mimeType, convertTo, buf, onUploadProgress }) => {
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
    headers: { 'Content-Type': mimeType, 'Content-Length': String(buf.length) },
    data: onUploadProgress ? uploadStream(buf, onUploadProgress, buf.length) : buf,
    responseType: 'json',
    // The job retries with a fresh body; an exhausted stream is not replayable.
    retry: false,
  });
  return data;
};

/**
 * Create-or-update a file by name inside a folder. Re-sharing the same record
 * therefore refreshes the files in place instead of piling up copies.
 * `convertTo` is the Google mime type to import into (e.g. a Google Doc).
 * The result's `created` tells callers whether the file existed before.
 * Pass `existing` (a file, or null for "known absent", from listChildren) to
 * skip the per-file lookup.
 * `onUploadProgress({ bytes_sent, bytes_total })` reports consumed payload
 * bytes. Only the resolved result confirms that Drive has saved the file.
 */
export const upsertFile = async (ctx, { parentId, name, mimeType, body, convertTo, existing: known, onUploadProgress }) => {
  const { drive } = ctx;
  const resolvedParent = currentFolderId(ctx, parentId);
  // A listing from the previous folder must never update files in that old
  // location after another upload has repaired the parent.
  if (resolvedParent !== parentId) known = undefined;
  parentId = resolvedParent;
  const lookup = async () => {
    const { data } = await drive.files.list({
      q: `name = '${escapeDriveQuery(name)}' and '${escapeDriveQuery(parentId)}' in parents and trashed = false`,
      fields: 'files(id,name,mimeType)',
      pageSize: 1,
      spaces: 'drive',
    });
    return data.files?.[0] || null;
  };
  let existing = known === undefined ? await lookup() : known;
  const size = Buffer.isBuffer(body) ? body.length : typeof body === 'string' ? Buffer.byteLength(body) : null;
  const upload = async () => {
    if (size != null && size > MULTIPART_MAX_BYTES) {
      const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
      return toFileResult(await resumableUpload(ctx, {
        fileId: existing?.id, name, parentId, mimeType, convertTo, buf, onUploadProgress,
      }), !existing);
    }
    // googleapis accepts a string or Readable, never a Buffer.
    const stream = uploadStream(body, onUploadProgress, size);
    const res = existing
      ? await drive.files.update({ fileId: existing.id, media: { mimeType, body: stream }, fields: FILE_FIELDS }, { retry: false })
      : await drive.files.create({
        requestBody: { name, parents: [parentId], ...(convertTo ? { mimeType: convertTo } : {}) },
        media: { mimeType, body: stream },
        fields: FILE_FIELDS,
      }, { retry: false });
    return toFileResult(res.data, !existing);
  };
  try { return await upload(); } catch (err) {
    // A file/folder can disappear after our listing. Replay only bodies we
    // own; arbitrary caller streams cannot be rewound safely.
    if (!isNotFound(err) || size === null) throw err;
    parentId = await repairFolder(ctx, parentId);
    existing = await lookup();
    return upload();
  }
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
  if (err?.code === 'GOOGLE_DRIVE_BUSY') {
    return { statusCode: 409, code: err.code, message: 'Google Drive folder preparation is busy. Retry the share in a few seconds.' };
  }
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
  if (['42P01', '42703'].includes(err?.code)) {
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
