import pool from '../config/db.js';
import asyncHandler from '../utils/asyncHandler.js';
import { encrypt, decrypt } from '../utils/tokenCrypto.js';
import { signOAuthState } from '../utils/googleOAuthState.js';
import { buildOAuthClient } from '../services/googleCalendarSync.service.js';
import {
  DRIVE_SCOPES,
  DRIVE_FILE_SCOPE,
  isDriveConfigured,
  getDriveConnection,
  driveClientFor,
  ensureRootFolder,
  folderUrl,
  grantAccess,
  updateAccess,
  revokeAccess,
  translateDriveError,
  sendDriveError,
} from '../services/googleDrive.service.js';

const FRONTEND_URL = (process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/$/, '');
const ROLES = ['writer', 'reader'];

// Drive and DB failures are answered here with a translated message; the
// error middleware would hide any 5xx behind "Something went wrong".
const driveHandler = (fn) => asyncHandler(async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    sendDriveError(res, err);
  }
});

// Google's id_token is received directly from Google over the TLS token
// exchange, so decoding its payload without signature verification is safe here.
const emailFromIdToken = (idToken) => {
  try {
    return JSON.parse(Buffer.from(String(idToken).split('.')[1], 'base64url').toString('utf8')).email || null;
  } catch {
    return null;
  }
};

const notConnected = (res) => res.status(409).json({
  message: 'Connect Google Drive in Settings first', code: 'GOOGLE_DRIVE_NOT_CONNECTED',
});

const publicConnection = (c) => ({
  google_account_email: c.google_account_email,
  status: c.status,
  root_folder_id: c.root_folder_id,
  root_folder_url: c.root_folder_id ? folderUrl(c.root_folder_id) : null,
  root_folder_name: c.root_folder_name,
  created_at: c.created_at,
  updated_at: c.updated_at,
});

const EMAIL_LIST_SQL = `SELECT e.id, e.email, e.role, e.created_at, u.name AS added_by_name
    FROM google_drive_access_emails e
    LEFT JOIN users u ON u.id = e.added_by
   WHERE e.organization_id=$1 ORDER BY e.email`;

export const getStatus = driveHandler(async (req, res) => {
  const orgId = req.user.organization_id;
  const [connection, emails] = await Promise.all([
    getDriveConnection(orgId),
    pool.query(EMAIL_LIST_SQL, [orgId]),
  ]);
  const active = connection?.status === 'active' ? connection : null;
  let rootFolderError = null;
  if (active && !active.root_folder_id) {
    // The callback creates the root folder best-effort; retry here so the
    // settings page can surface a Drive-side problem (API disabled, quota).
    try {
      const ctx = await driveClientFor(orgId);
      if (ctx) active.root_folder_id = await ensureRootFolder(ctx);
    } catch (err) {
      console.error('[gdrive] root folder check failed:', err.message);
      rootFolderError = translateDriveError(err).message;
    }
  }
  res.json({
    configured: isDriveConfigured(),
    connection: active ? publicConnection(active) : null,
    connection_status: connection?.status || 'disconnected',
    root_folder_error: rootFolderError,
    emails: emails.rows,
  });
});

export const getConnectUrl = asyncHandler(async (req, res) => {
  if (!isDriveConfigured()) {
    return res.status(503).json({ message: 'Google Drive integration is not configured on this server' });
  }
  const url = buildOAuthClient().generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent', // guarantees a refresh_token even on reconnect
    scope: DRIVE_SCOPES,
    state: signOAuthState({ orgId: req.user.organization_id, userId: req.user.id, origin: FRONTEND_URL, kind: 'drive' }),
  });
  res.json({ url });
});

/** Called by the calendar OAuth callback once the signed state says `kind: 'drive'`. */
export const handleDriveOAuthCallback = async (req, res, state) => {
  const landing = `${state.origin}/settings/google-drive?google=`;
  const fail = (reason) => res.redirect(`${landing}error&reason=${encodeURIComponent(reason)}`);
  if (!isDriveConfigured()) return fail('not_configured');
  if (req.query.error) return fail(String(req.query.error));
  if (!req.query.code) return fail('missing_code');

  let tokens;
  try {
    ({ tokens } = await buildOAuthClient().getToken(String(req.query.code)));
  } catch (err) {
    console.error('[gdrive] token exchange failed:', err.message);
    return fail('token_exchange_failed');
  }
  if (!tokens.refresh_token) return fail('no_refresh_token');
  const email = emailFromIdToken(tokens.id_token);
  if (!email) return fail('no_account_email');
  // Granular consent lets the user untick Drive while still completing sign-in.
  if (!String(tokens.scope || '').split(/\s+/).includes(DRIVE_FILE_SCOPE)) return fail('drive_scope_denied');

  try {
    await pool.query(
      `INSERT INTO google_drive_connections
         (organization_id, google_account_email, access_token_enc, refresh_token_enc, token_expiry, scope, connected_by, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'active')
       ON CONFLICT (organization_id) DO UPDATE SET
         google_account_email=EXCLUDED.google_account_email,
         access_token_enc=EXCLUDED.access_token_enc,
         refresh_token_enc=EXCLUDED.refresh_token_enc,
         token_expiry=EXCLUDED.token_expiry,
         scope=EXCLUDED.scope,
         connected_by=EXCLUDED.connected_by,
         status='active',
         updated_at=NOW()`,
      [state.orgId, email, encrypt(tokens.access_token), encrypt(tokens.refresh_token),
        tokens.expiry_date ? new Date(tokens.expiry_date) : null, tokens.scope, state.userId],
    );
  } catch (err) {
    // The user is on Google's redirect: land them in Settings with a toast,
    // not on a JSON error page.
    console.error('[gdrive] failed to store connection:', err.message);
    return fail('server_error');
  }
  try {
    const ctx = await driveClientFor(state.orgId);
    if (ctx) await ensureRootFolder(ctx);
  } catch (err) {
    // getStatus retries and reports this; the connection itself succeeded.
    console.error('[gdrive] root folder creation failed:', err.message);
  }
  res.redirect(`${landing}connected`);
};

export const disconnect = driveHandler(async (req, res) => {
  const orgId = req.user.organization_id;
  const { rows } = await pool.query(
    `SELECT id, google_account_email, refresh_token_enc FROM google_drive_connections
      WHERE organization_id=$1 AND status='active' LIMIT 1`,
    [orgId],
  );
  if (!rows[0]) return res.status(404).json({ message: 'No Google Drive connection to disconnect' });

  // Google revokes the whole (account × OAuth client) grant, which would also
  // kill a Calendar connection on the same account — so only revoke when the
  // calendar side is not using it.
  let calendarActive = false;
  try {
    const sibling = await pool.query(
      `SELECT 1 FROM google_calendar_connections
        WHERE organization_id=$1 AND status='active' AND google_account_email=$2 LIMIT 1`,
      [orgId, rows[0].google_account_email],
    );
    calendarActive = sibling.rowCount > 0;
  } catch (err) {
    if (err.code !== '42P01') throw err;
  }
  if (!calendarActive) {
    try {
      await buildOAuthClient().revokeToken(decrypt(rows[0].refresh_token_enc));
    } catch (err) {
      console.error('[gdrive] token revoke failed (continuing):', err.message);
    }
  }
  await pool.query(
    `UPDATE google_drive_connections SET status='revoked', updated_at=NOW() WHERE id=$1`,
    [rows[0].id],
  );
  // Access grants and cached folder ids belong to the old account's Drive.
  await pool.query('DELETE FROM google_drive_access_emails WHERE organization_id=$1', [orgId]);
  await pool.query('DELETE FROM google_drive_folders WHERE organization_id=$1', [orgId]);
  res.json({ success: true });
});

export const listAccessEmails = driveHandler(async (req, res) => {
  const { rows } = await pool.query(EMAIL_LIST_SQL, [req.user.organization_id]);
  res.json({ emails: rows });
});

export const addAccessEmail = driveHandler(async (req, res) => {
  const orgId = req.user.organization_id;
  const email = String(req.body.email || '').trim().toLowerCase();
  const role = req.body.role || 'writer';
  if (!/^\S+@\S+\.\S+$/.test(email) || email.length > 255) {
    return res.status(400).json({ message: 'A valid email address is required' });
  }
  if (!ROLES.includes(role)) return res.status(400).json({ message: 'Role must be writer or reader' });

  const ctx = await driveClientFor(orgId);
  if (!ctx) return notConnected(res);
  const dup = await pool.query(
    'SELECT 1 FROM google_drive_access_emails WHERE organization_id=$1 AND email=$2',
    [orgId, email],
  );
  if (dup.rowCount) return res.status(409).json({ message: 'This email already has access' });

  // Drive first: a row without a permission would claim access that was
  // never granted.
  await ensureRootFolder(ctx);
  const permissionId = await grantAccess(ctx, { email, role });
  const { rows } = await pool.query(
    `INSERT INTO google_drive_access_emails (organization_id, email, role, drive_permission_id, added_by)
     VALUES ($1,$2,$3,$4,$5) ON CONFLICT (organization_id, email) DO NOTHING RETURNING id, email, role`,
    [orgId, email, role, permissionId, req.user.id],
  );
  if (!rows[0]) return res.status(409).json({ message: 'This email already has access' });
  res.status(201).json({ email: rows[0] });
});

const findAccessEmail = async (req) => {
  const { rows } = await pool.query(
    'SELECT id, email, role, drive_permission_id FROM google_drive_access_emails WHERE id=$1 AND organization_id=$2',
    [Number(req.params.id) || 0, req.user.organization_id],
  );
  return rows[0] || null;
};

export const updateAccessEmail = driveHandler(async (req, res) => {
  const role = req.body.role;
  if (!ROLES.includes(role)) return res.status(400).json({ message: 'Role must be writer or reader' });
  const row = await findAccessEmail(req);
  if (!row) return res.status(404).json({ message: 'Email not found' });
  const ctx = await driveClientFor(req.user.organization_id);
  if (!ctx) return notConnected(res);
  if (row.drive_permission_id) {
    await ensureRootFolder(ctx);
    await updateAccess(ctx, { permissionId: row.drive_permission_id, role });
  }
  await pool.query('UPDATE google_drive_access_emails SET role=$1 WHERE id=$2', [role, row.id]);
  res.json({ email: { id: row.id, email: row.email, role } });
});

export const removeAccessEmail = driveHandler(async (req, res) => {
  const row = await findAccessEmail(req);
  if (!row) return res.status(404).json({ message: 'Email not found' });
  const ctx = await driveClientFor(req.user.organization_id);
  // Drive first; a non-404 failure answers via sendDriveError and keeps the
  // row so the grant is never silently left behind in Drive.
  if (ctx && row.drive_permission_id) {
    await ensureRootFolder(ctx);
    await revokeAccess(ctx, { permissionId: row.drive_permission_id });
  }
  await pool.query('DELETE FROM google_drive_access_emails WHERE id=$1', [row.id]);
  res.json({ success: true });
});

export const listRecentShares = driveHandler(async (req, res) => {
  const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 20, 1), 50);
  const siteId = Number.parseInt(req.query.site_id, 10) || null;
  const { rows } = await pool.query(
    `SELECT s.id, s.module, s.scope, s.label, s.folder_path, s.folder_url, s.files, s.status, s.error,
            s.site_id, st.name AS site_name, u.name AS shared_by_name, s.created_at, s.entity_id, s.payment_id
       FROM google_drive_shares s
       LEFT JOIN users u ON u.id = s.shared_by
       LEFT JOIN sites st ON st.id = s.site_id
      WHERE s.organization_id=$1 AND ($2::int IS NULL OR s.site_id=$2)
      ORDER BY s.created_at DESC, s.id DESC
      LIMIT $3`,
    [req.user.organization_id, siteId, limit],
  );
  res.json({ shares: rows });
});
