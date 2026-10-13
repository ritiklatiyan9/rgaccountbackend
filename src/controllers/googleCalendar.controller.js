import pool from '../config/db.js';
import asyncHandler from '../utils/asyncHandler.js';
import { encrypt, decrypt } from '../utils/tokenCrypto.js';
import { signOAuthState, verifyOAuthState } from '../utils/googleOAuthState.js';
import { buildOAuthClient, backfillOrgEvents } from '../services/googleCalendarSync.service.js';
import { handleDriveOAuthCallback } from './googleDrive.controller.js';
import { calendarSyncError } from '../services/googleCalendarError.service.js';

const FRONTEND_URL = (process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/$/, '');
const settingsPage = (origin) => `${origin}/settings/calendar`;

// A local settings session uses the registered hosted Google callback, then
// returns to its own app. Never accept an arbitrary return address.
const originFor = req => {
  const origin = req.get?.('Origin') || req.headers?.origin;
  return [FRONTEND_URL, 'http://127.0.0.1:5174', 'http://localhost:5174'].includes(origin) ? origin : FRONTEND_URL;
};
// openid+email are only used to learn which Google account was connected;
// calendar.events is the least-privilege calendar scope (no calendar list/settings access).
const SCOPES = ['openid', 'email', 'https://www.googleapis.com/auth/calendar.events'];

const isConfigured = () =>
  Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET
    && process.env.GOOGLE_REDIRECT_URI && process.env.CALENDAR_TOKEN_ENC_KEY);

// Google's id_token is received directly from Google over the TLS token
// exchange, so decoding its payload without signature verification is safe here.
const emailFromIdToken = (idToken) => {
  try {
    return JSON.parse(Buffer.from(String(idToken).split('.')[1], 'base64url').toString('utf8')).email || null;
  } catch {
    return null;
  }
};

export const getConnectUrl = asyncHandler(async (req, res) => {
  if (!isConfigured()) {
    return res.status(503).json({ message: 'Google Calendar integration is not configured on this server' });
  }
  let loginHint;
  if (req.query.connection_id != null) {
    const id = Number(req.query.connection_id);
    if (!Number.isSafeInteger(id) || id <= 0) return res.status(400).json({ message: 'Choose a valid calendar account' });
    const { rows } = await pool.query('SELECT google_account_email FROM google_calendar_connections WHERE id=$1 AND organization_id=$2', [id, req.user.organization_id]);
    if (!rows[0]) return res.status(404).json({ message: 'Calendar account not found' });
    loginHint = rows[0].google_account_email;
  }
  const url = buildOAuthClient().generateAuthUrl({
    ...(loginHint ? { login_hint: loginHint } : {}),
    access_type: 'offline',
    prompt: 'select_account consent',
    scope: SCOPES,
    state: signOAuthState({ orgId: req.user.organization_id, userId: req.user.id, origin: originFor(req), kind: 'calendar' }),
  });
  res.json({ url });
});

export const oauthCallback = asyncHandler(async (req, res) => {
  // Until the state is verified the tenant host is unknown, so early failures
  // land on the configured front end rather than a caller-supplied one.
  let origin = FRONTEND_URL;
  const fail = (reason) => res.redirect(`${settingsPage(origin)}?google=error&reason=${encodeURIComponent(reason)}`);
  // Google Drive shares this OAuth client and redirect URI; the signed state's
  // kind says which integration started the flow. Verify it first because
  // Google echoes the state on error redirects too.
  const state = verifyOAuthState(req.query.state);
  if (state?.kind === 'drive') return handleDriveOAuthCallback(req, res, state);
  if (state && state.kind !== 'calendar') return fail('invalid_state');
  if (state) origin = state.origin;
  if (!isConfigured()) return fail('not_configured');
  if (req.query.error) return fail(String(req.query.error));
  if (!state) return fail('invalid_state');
  if (!req.query.code) return fail('missing_code');

  let tokens;
  try {
    ({ tokens } = await buildOAuthClient().getToken(String(req.query.code)));
  } catch (err) {
    console.error('[gcal] token exchange failed:', err.message);
    return fail('token_exchange_failed');
  }
  if (!tokens.refresh_token) return fail('no_refresh_token');
  const email = String(emailFromIdToken(tokens.id_token) || '').trim().toLowerCase();
  if (!email) return fail('no_account_email');

  let connectionId;
  try {
    const { rows } = await pool.query(
      `INSERT INTO google_calendar_connections
         (organization_id, google_account_email, access_token_enc, refresh_token_enc, token_expiry, scope, connected_by, status, notify_attendees)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'active',FALSE)
       ON CONFLICT (organization_id,LOWER(google_account_email)) DO UPDATE SET
         google_account_email=EXCLUDED.google_account_email,
         access_token_enc=EXCLUDED.access_token_enc,
         refresh_token_enc=EXCLUDED.refresh_token_enc,
         token_expiry=EXCLUDED.token_expiry,
         scope=EXCLUDED.scope,
         connected_by=EXCLUDED.connected_by,
         status='active',
         notify_attendees=FALSE,
         updated_at=NOW() RETURNING id`,
      [state.orgId, email, encrypt(tokens.access_token), encrypt(tokens.refresh_token),
        tokens.expiry_date ? new Date(tokens.expiry_date) : null, tokens.scope || SCOPES.join(' '), state.userId],
    );
    connectionId = rows[0].id;
  } catch (err) {
    // A user on Google's redirect should land back in Settings with a toast,
    // not on a raw JSON error page (e.g. a malformed CALENDAR_TOKEN_ENC_KEY).
    console.error('[gcal] failed to store connection:', err.message);
    return fail('server_error');
  }
  // Existing future-dated events appear on the calendar without waiting to be
  // edited. Fire-and-forget: the admin's redirect must not wait on N API calls.
  backfillOrgEvents(state.orgId, connectionId).catch((err) => {
    console.error(`[gcal] backfill (org ${state.orgId}) failed:`, err.message);
  });
  res.redirect(`${settingsPage(origin)}?google=connected`);
});

const selectedConnectionId = req => req.body?.connection_id == null ? null : Number(req.body.connection_id);
const validConnectionId = id => id == null || (Number.isSafeInteger(id) && id > 0);

export const disconnect = asyncHandler(async (req, res) => {
  const orgId = req.user.organization_id, requestedId = selectedConnectionId(req);
  if (!validConnectionId(requestedId)) return res.status(400).json({ message: 'Choose a valid calendar account' });
  const { rows } = await pool.query(`SELECT id,google_account_email,refresh_token_enc FROM google_calendar_connections
    WHERE organization_id=$1 AND status IN ('active','reauthorization_required') AND ($2::bigint IS NULL OR id=$2) ORDER BY id`, [orgId, requestedId]);
  if (!rows.length) return res.status(404).json({ message: 'Calendar account not found' });
  if (rows.length > 1) return res.status(400).json({ message: 'Choose which calendar account to disconnect' });
  const account = rows[0];
  // Revoking a Google grant affects every token for that Google account.
  // Keep a grant that is still used by Drive or another calendar connection.
  let driveActive = false;
  try {
    const sibling = await pool.query(`SELECT 1 FROM google_drive_connections
      WHERE organization_id=$1 AND status='active' AND google_account_email=$2 LIMIT 1`, [orgId, account.google_account_email]);
    driveActive = sibling.rowCount > 0;
  } catch (error) { if (error.code !== '42P01') throw error; }
  const siblingCalendar = await pool.query(`SELECT 1 FROM google_calendar_connections
    WHERE id<>$1 AND status='active' AND LOWER(google_account_email)=LOWER($2) LIMIT 1`, [account.id, account.google_account_email]);
  if (!driveActive && !siblingCalendar.rowCount) {
    try { await buildOAuthClient().revokeToken(decrypt(account.refresh_token_enc)); }
    catch (error) { console.error('[gcal] token revoke failed (continuing):', error.message); }
  }
  await pool.query("UPDATE google_calendar_connections SET status='revoked',updated_at=NOW() WHERE id=$1 AND organization_id=$2", [account.id, orgId]);
  // Preserve each account's canonical mapping for a later reconnect.
  await pool.query(`UPDATE google_calendar_event_links SET sync_status='DISCONNECTED',updated_at=NOW()
    WHERE organization_id=$1 AND connection_id=$2`, [orgId, account.id]);
  res.json({ success: true, connection_id: account.id });
});

export const syncFutureEvents = asyncHandler(async (req, res) => {
  if (!isConfigured()) return res.status(503).json({ message: 'Google Calendar integration is not configured on this server' });
  const id = selectedConnectionId(req);
  if (!validConnectionId(id)) return res.status(400).json({ message: 'Choose a valid calendar account' });
  const { rows } = await pool.query(`SELECT id FROM google_calendar_connections
    WHERE organization_id=$1 AND status='active' AND ($2::bigint IS NULL OR id=$2)`, [req.user.organization_id, id]);
  if (!rows.length) return res.status(404).json({ message: 'No active calendar account found' });
  const result = await backfillOrgEvents(req.user.organization_id, id);
  res.json({ success: result.failed === 0, ...result, accounts: rows.length });
});

export const getStatus = asyncHandler(async (req, res) => {
  const { rows } = await pool.query(`WITH future_events AS (
      SELECT organization_id,id AS source_id,'COMPLIANCE' AS event_type FROM compliance_items
        WHERE organization_id=$1 AND deleted_at IS NULL AND current_due_date>=CURRENT_DATE
      UNION ALL SELECT organization_id,id,'LEGAL_HEARING' FROM legal_cases
        WHERE organization_id=$1 AND deleted_at IS NULL AND next_hearing_date>=CURRENT_DATE
      UNION ALL SELECT organization_id,id,'NOTICE_REPLY' FROM legal_notices
        WHERE organization_id=$1 AND deleted_at IS NULL AND reply_due_date>=CURRENT_DATE
      UNION ALL SELECT organization_id,id,'INSPECTION' FROM compliance_inspections
        WHERE organization_id=$1 AND deleted_at IS NULL AND scheduled_at>=CURRENT_DATE
      UNION ALL SELECT organization_id,id,'LICENCE_EXPIRY' FROM compliance_licences
        WHERE organization_id=$1 AND deleted_at IS NULL AND expiry_date>=CURRENT_DATE
    ) SELECT c.id,c.google_account_email,c.status,c.created_at,c.updated_at,
      totals.synced,totals.failed,totals.pending,totals.last_synced_at,latest.failure_reason
    FROM google_calendar_connections c
    LEFT JOIN LATERAL (
      SELECT COUNT(*) FILTER (WHERE g.sync_status='SYNCED')::int AS synced,
        COUNT(*) FILTER (WHERE g.sync_status='FAILED')::int AS failed,
        COUNT(*) FILTER (WHERE g.sync_status IN ('PENDING','PROCESSING'))::int AS pending,
        MAX(g.last_synced_at) AS last_synced_at
      FROM google_calendar_event_links g JOIN future_events e
        ON e.organization_id=g.organization_id AND e.event_type=g.event_type AND e.source_id=g.source_id
      WHERE g.connection_id=c.id AND g.organization_id=c.organization_id
    ) totals ON TRUE
    LEFT JOIN LATERAL (
      SELECT g.failure_reason FROM google_calendar_event_links g JOIN future_events e
        ON e.organization_id=g.organization_id AND e.event_type=g.event_type AND e.source_id=g.source_id
      WHERE g.connection_id=c.id AND g.organization_id=c.organization_id AND g.sync_status='FAILED'
      ORDER BY g.updated_at DESC,g.id DESC LIMIT 1
    ) latest ON TRUE
    WHERE c.organization_id=$1 ORDER BY c.created_at,c.id`, [req.user.organization_id]);
  const accounts = rows.filter(account => ['active','reauthorization_required'].includes(account.status)).map(({ failure_reason, ...account }) => ({
    ...account,
    sync_error: account.status === 'reauthorization_required' ? calendarSyncError('invalid_grant')
      : account.failed ? calendarSyncError(failure_reason) : null,
  }));
  const firstActive = accounts.find(account => account.status === 'active');
  res.set('Cache-Control', 'no-store').json({
    configured: isConfigured(), connections: accounts,
    connection: firstActive || null,
    connection_status: firstActive ? 'active' : rows.at(-1)?.status || 'disconnected',
  });
});
