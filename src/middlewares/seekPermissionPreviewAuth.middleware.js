// Preview-only bridge for a hosted Accounts session. The fixed upstream proves
// the complete token; every local request still checks current account/session
// state. Production auth and JWT verification are unchanged.
import { createHash } from 'node:crypto';
import { assertAppLoginAccess } from '../services/appLoginAccess.js';

export const SEEK_PREVIEW_AUTH_URL = 'https://rgaccountbackend.onrender.com/auth/me';
const ORIGINS = new Set(['http://127.0.0.1:5174', 'http://localhost:5174']);
const fail = (message, statusCode = 401, code = 'SEEK_PREVIEW_SESSION_INVALID') => Object.assign(new Error(message), { statusCode, code });
const unavailable = () => fail('Accounts session verification is temporarily unavailable. Please try again.', 503, 'SEEK_PREVIEW_AUTH_UNAVAILABLE');
const uint = (value, zero = false) => Number.isSafeInteger(Number(value)) && Number(value) >= (zero ? 0 : 1)
  && Number(value) <= 2147483647 && /^\d+$/.test(String(value));

export function createSeekPermissionPreviewAuth({ database, request = fetch, now = Date.now,
  proofTtlMs = 60000, maxProofs = 256, maxInFlight = 64 } = {}) {
  if (!database?.query) throw new Error('Preview authentication requires a database');
  const proofs = new Map();
  const pending = new Map();
  const ttl = Math.min(Math.max(Number(proofTtlMs) || 60000, 1), 60000);
  const capacity = Math.min(Math.max(Number(maxProofs) || 256, 1), 1024);
  const inFlightCapacity = Math.min(Math.max(Number(maxInFlight) || 64, 1), 128);

  async function verifyHosted(token, sessionId) {
    let response;
    try {
      response = await request(SEEK_PREVIEW_AUTH_URL, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(10000),
        headers: { Authorization: `Bearer ${token}`, 'X-App-Context': 'accounts', ...(sessionId ? { 'X-Session-ID': String(sessionId) } : {}) } });
    } catch { throw unavailable(); }
    if ([401, 403].includes(response.status)) throw fail('The Accounts session is no longer valid.', response.status);
    if (!response.ok) throw unavailable();
    let remote;
    try { remote = (await response.json())?.user; } catch { throw unavailable(); }
    if (!uint(remote?.id) || !uint(remote?.organization_id) || remote?.is_active !== true) throw unavailable();
    if (!['admin', 'super_admin', 'sub_admin'].includes(remote.role)) throw fail('Insufficient permissions', 403);

    // Decode only AFTER the upstream authenticated this exact token. These
    // claims bind its identity, expiry and revocation version to local state;
    // decoding itself is never considered proof of a valid signature.
    let claims;
    try { claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')); }
    catch { throw fail('The Accounts session is invalid.'); }
    if (!claims || Array.isArray(claims) || !uint(claims.id) || Number(claims.id) !== Number(remote.id)
      || !uint(claims.version, true) || !Number.isSafeInteger(claims.exp) || claims.exp * 1000 <= now()) {
      throw fail('The Accounts session is invalid or expired.');
    }
    assertAppLoginAccess(remote, 'accounts', claims);
    return { id: Number(remote.id), organization_id: Number(remote.organization_id), role: remote.role,
      version: Number(claims.version), claims, validUntil: Math.min(now() + ttl, claims.exp * 1000) };
  }

  async function resolve({ token, sessionId: rawSession, appContext = 'accounts', origin } = {}) {
    if (origin && !ORIGINS.has(origin)) throw fail('This session bridge is available only to the local Accounts dashboard.', 403);
    if (appContext !== 'accounts') throw fail('This preview requires an Accounts session.', 403, 'APP_ACCESS_DENIED');
    if (typeof token !== 'string' || token.length > 16384 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) {
      throw fail('No valid Accounts token provided.');
    }
    const hasSession = rawSession !== undefined && rawSession !== null && rawSession !== '';
    if (hasSession && !uint(rawSession)) throw fail('Invalid session context.');
    const sessionId = hasSession ? Number(rawSession) : null;
    const key = createHash('sha256').update(`${token}\0${sessionId ?? ''}\0accounts`).digest('hex');
    let proof = proofs.get(key);
    if (proof?.validUntil <= now()) { proofs.delete(key); proof = null; }
    if (!proof) {
      let operation = pending.get(key);
      if (!operation) {
        if (pending.size >= inFlightCapacity) throw unavailable();
        operation = verifyHosted(token, sessionId).then(value => {
          // Delete stale proofs first; fixed capacity also bounds memory when
          // many distinct valid sessions use this preview.
          for (const [oldKey, oldProof] of proofs) if (oldProof.validUntil <= now()) proofs.delete(oldKey);
          while (proofs.size >= capacity) proofs.delete(proofs.keys().next().value);
          proofs.set(key, value);
          return value;
        }).finally(() => pending.delete(key));
        pending.set(key, operation);
      }
      proof = await operation;
    }
    if (proof.role !== 'super_admin' && !sessionId) throw fail('A current Accounts session ID is required.', 401, 'SESSION_CONTEXT_REQUIRED');
    let user;
    try {
      ({ rows: [user] } = await database.query(`SELECT u.id, u.name, u.role, u.organization_id, u.is_active, u.token_version,
        u.can_login_accounts, u.can_login_booking_accounts, s.id AS session_id, s.logout_time AS session_logout_time
        FROM users u LEFT JOIN user_sessions s ON s.id = $2::integer AND s.user_id = u.id WHERE u.id = $1`, [proof.id, sessionId]));
    } catch { throw unavailable(); }
    if (!user?.is_active || user.role !== proof.role || Number(user.organization_id) !== proof.organization_id
      || Number(user.token_version) !== proof.version || proof.claims.exp * 1000 <= now()
      || (sessionId && (Number(user.session_id) !== sessionId || user.session_logout_time))) {
      proofs.delete(key);
      throw fail('The Accounts session has changed or expired. Please sign in again.');
    }
    try { assertAppLoginAccess(user, 'accounts', proof.claims); }
    catch (error) { proofs.delete(key); throw error; }
    return { user: { id: Number(user.id), name: user.name, role: user.role, organization_id: Number(user.organization_id),
      version: proof.version, app: 'accounts', permissionsByModule: new Map() }, authenticatedUser: user, sessionId, appContext: 'accounts' };
  }

  const authenticate = async (req, res, next) => {
    const authorization = req.header('Authorization');
    try {
      const value = await resolve({ token: typeof authorization === 'string' && authorization.startsWith('Bearer ') ? authorization.slice(7) : undefined,
        sessionId: req.header('X-Session-ID'), appContext: req.header('X-App-Context') || 'accounts', origin: req.header('Origin') });
      req.user = value.user; req.authenticatedUser = value.authenticatedUser; req.sessionId = value.sessionId; req.appContext = value.appContext;
      next();
    } catch (error) {
      const status = error.statusCode || 503;
      if (status === 503) res.set('Retry-After', '5');
      res.status(status).json({ message: error.statusCode ? error.message : unavailable().message, code: error.code || 'SEEK_PREVIEW_AUTH_UNAVAILABLE' });
    }
  };
  const resolveSocket = socket => resolve({ token: socket.handshake.auth?.token, sessionId: socket.handshake.auth?.sessionId,
    appContext: socket.handshake.auth?.appContext || 'accounts', origin: socket.handshake.headers?.origin });
  const bindSocket = (socket, value) => {
    socket.user = value.user; socket.appContext = value.appContext; socket.sessionId = value.sessionId;
  };
  const authenticateSocket = async (socket, next) => {
    try {
      bindSocket(socket, await resolveSocket(socket));
      next();
    } catch (error) {
      const denied = new Error(error.statusCode === 503 ? unavailable().message : 'Authentication error');
      denied.data = { status: error.statusCode || 503, code: error.code || 'SEEK_PREVIEW_AUTH_UNAVAILABLE' };
      next(denied);
    }
  };
  const authorizeUserDelivery = async socket => {
    try { bindSocket(socket, await resolveSocket(socket)); return true; }
    catch { return false; }
  };
  return { authenticate, authenticateSocket, authorizeUserDelivery, resolve };
}
