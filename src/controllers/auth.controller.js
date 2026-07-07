import crypto from 'crypto';
import asyncHandler from '../utils/asyncHandler.js';
import { signAccessToken, signRefreshToken, verifyToken, hashPassword, comparePassword, hashRefreshToken } from '../config/jwt.js';
import { uploadSingle } from '../utils/upload.js';
import { firebaseEnabled, verifyFirebaseIdToken } from '../config/firebaseAdmin.js';
import { mailerEnabled, sendLoginOtpEmail } from '../utils/mailer.js';
import userModel from '../models/User.model.js';
import siteModel from '../models/Site.model.js';
import permissionModel from '../models/Permission.model.js';
import pool from '../config/db.js';

/* ── Email OTP second factor — super_admin / admin / sub_admin only ── */
const OTP_ROLES = new Set(['super_admin', 'admin', 'sub_admin']);
const OTP_TTL_MINUTES = 5;
const OTP_MAX_ATTEMPTS = 5;
const OTP_RESEND_SECONDS = 30;

const maskEmail = (email) => {
  const [local, domain] = String(email).split('@');
  if (!domain) return email;
  return `${local.slice(0, 2)}${'•'.repeat(Math.max(2, local.length - 2))}@${domain}`;
};

/** OTP applies to admin-class roles whenever the mailer is configured. */
const needsOtp = (user) => OTP_ROLES.has(user.role) && mailerEnabled();

/**
 * Everything a successful sign-in returns (tokens + sites + permissions + session).
 * Shared by password login, Google login and the OTP verification step so all three
 * produce the exact same payload the frontend already consumes.
 */
const buildLoginPayload = async (user, req) => {
  const version = user.token_version;
  const accessToken = signAccessToken({ id: user.id, email: user.email, role: user.role, version });
  const refreshToken = signRefreshToken({ id: user.id, version });
  const hashedRefresh = await hashRefreshToken(refreshToken);
  await userModel.update(user.id, { refresh_token: hashedRefresh }, pool);

  let sites;
  if (user.role === 'admin' || user.role === 'super_admin') {
    sites = await siteModel.findAll(pool);
  } else {
    sites = await siteModel.findByUserId(user.id, pool);
  }

  let permissions = null;
  if (user.role === 'sub_admin') {
    permissions = await permissionModel.getByUserId(user.id);
  }

  // Record login session (skip for super_admin to hide from activity)
  let sessionId = null;
  if (user.role !== 'super_admin') {
    const ipAddress = req.ip || req.connection?.remoteAddress;
    const sessionResult = await pool.query(
      'INSERT INTO user_sessions (user_id, ip_address) VALUES ($1, $2) RETURNING id',
      [user.id, ipAddress]
    );
    sessionId = sessionResult.rows[0].id;
  }

  return { user: userModel.sanitize(user), accessToken, refreshToken, sites, permissions, sessionId };
};

/**
 * Second sign-in step: park the login as a pending challenge in the shared
 * `login_otps` table (created by the booking app's migration 012 — same database)
 * and email a 6-digit code. No JWTs leave the server until /auth/verify-otp.
 */
const startOtpChallenge = async (user, res) => {
  const otp = String(crypto.randomInt(100000, 1000000));
  const pendingToken = crypto.randomBytes(24).toString('hex');
  const otpHash = await hashPassword(otp);

  await pool.query('DELETE FROM login_otps WHERE user_id = $1', [user.id]);
  await pool.query(
    `INSERT INTO login_otps (user_id, pending_token, otp_hash, expires_at)
     VALUES ($1, $2, $3, now() + ($4 || ' minutes')::interval)`,
    [user.id, pendingToken, otpHash, OTP_TTL_MINUTES]
  );

  try {
    await sendLoginOtpEmail({ to: user.email, name: user.name, otp, minutes: OTP_TTL_MINUTES });
  } catch (err) {
    await pool.query('DELETE FROM login_otps WHERE pending_token = $1', [pendingToken]);
    console.error('[auth] OTP email failed:', err.message);
    return res.status(502).json({ message: 'Could not send the verification email. Try again or contact your admin.' });
  }

  res.json({
    otp_required: true,
    pending_token: pendingToken,
    email_hint: maskEmail(user.email),
    expires_in: OTP_TTL_MINUTES * 60,
    resend_after: OTP_RESEND_SECONDS,
  });
};

/**
 * POST /auth/register
 * First-ever admin registration via Postman (no auth required).
 * If an admin already exists, this endpoint is LOCKED.
 */
export const register = asyncHandler(async (req, res) => {
  const { name, email, password, phone } = req.body;

  // Only allow if NO admin exists yet
  const hasAdmin = await userModel.adminExists(pool);
  if (hasAdmin) {
    return res.status(403).json({ message: 'Admin already exists. Use admin panel to create sub-admins.' });
  }

  const existing = await userModel.findByEmail(email, pool);
  if (existing) return res.status(400).json({ message: 'User with this email already exists' });

  const hashedPassword = await hashPassword(password);
  let photoUrl = null;
  if (req.file) {
    photoUrl = await uploadSingle(req.file, 'cloudinary');
  }

  const userData = {
    name,
    email,
    password: hashedPassword,
    phone: phone || null,
    photo: photoUrl,
    role: 'admin',
    is_active: true,
    token_version: 1,
  };

  const user = await userModel.create(userData, pool);
  const accessToken = signAccessToken({ id: user.id, email: user.email, role: user.role, version: 1 });
  const refreshToken = signRefreshToken({ id: user.id, version: 1 });
  const hashedRefresh = await hashRefreshToken(refreshToken);
  await userModel.update(user.id, { refresh_token: hashedRefresh }, pool);

  res.status(201).json({ user: userModel.sanitize(user), accessToken, refreshToken });
});

/**
 * POST /auth/login
 */
export const login = asyncHandler(async (req, res) => {
  const { email, password } = req.body;
  const user = await userModel.findByEmail(email, pool);

  if (!user || !(await comparePassword(password, user.password))) {
    return res.status(401).json({ message: 'Invalid credentials' });
  }

  if (!user.is_active) {
    return res.status(403).json({ message: 'Account is deactivated. Contact your admin.' });
  }

  // Admin-class roles confirm a 6-digit code emailed to the account's address
  // before any tokens are issued (second authentication step).
  if (needsOtp(user)) return startOtpChallenge(user, res);

  res.json(await buildLoginPayload(user, req));
});

/**
 * POST /auth/google — Sign in with Google.
 * The frontend runs the Firebase Google popup and sends the Firebase ID token here.
 * Sign-in works ONLY when the Google email already belongs to a users row (created
 * by an admin) — there is deliberately no self-signup. Admin-class roles still get
 * the OTP second step afterwards.
 */
export const googleLogin = asyncHandler(async (req, res) => {
  const { credential } = req.body;
  if (!credential || typeof credential !== 'string') {
    return res.status(400).json({ message: 'Missing Google credential' });
  }
  if (!firebaseEnabled()) {
    return res.status(503).json({ message: 'Google Sign-In is not configured on this server' });
  }

  let decoded;
  try {
    decoded = await verifyFirebaseIdToken(credential);
  } catch {
    return res.status(401).json({ message: 'Invalid Google credential' });
  }
  if (decoded.firebase?.sign_in_provider !== 'google.com') {
    return res.status(401).json({ message: 'Only Google sign-in is accepted here' });
  }
  if (!decoded.email || decoded.email_verified !== true) {
    return res.status(401).json({ message: 'Your Google account has no verified email' });
  }

  const { rows } = await pool.query('SELECT * FROM users WHERE lower(email) = lower($1) LIMIT 1', [decoded.email]);
  const user = rows[0];
  if (!user) {
    return res.status(403).json({
      message: `No account is linked to ${decoded.email}. Ask your admin to create your account with this email, then try again.`,
    });
  }
  if (!user.is_active) {
    return res.status(403).json({ message: 'Account is deactivated. Contact your admin.' });
  }

  if (needsOtp(user)) return startOtpChallenge(user, res);

  res.json({ ...(await buildLoginPayload(user, req)), via: 'google' });
});

/**
 * POST /auth/verify-otp — body { pending_token, otp }. Completes an admin login:
 * single-use, 5-minute expiry, dead after 5 wrong attempts.
 */
export const verifyLoginOtp = asyncHandler(async (req, res) => {
  const { pending_token, otp } = req.body;
  if (!pending_token || !otp) {
    return res.status(400).json({ message: 'pending_token and otp are required' });
  }

  const { rows } = await pool.query('SELECT * FROM login_otps WHERE pending_token = $1 LIMIT 1', [String(pending_token)]);
  const challenge = rows[0];
  if (!challenge || challenge.consumed_at) {
    return res.status(401).json({ message: 'This sign-in attempt is no longer valid. Please sign in again.' });
  }
  if (new Date(challenge.expires_at) < new Date()) {
    await pool.query('DELETE FROM login_otps WHERE id = $1', [challenge.id]);
    return res.status(401).json({ message: 'The code has expired. Please sign in again.' });
  }
  if (challenge.attempts >= OTP_MAX_ATTEMPTS) {
    await pool.query('DELETE FROM login_otps WHERE id = $1', [challenge.id]);
    return res.status(401).json({ message: 'Too many wrong attempts. Please sign in again.' });
  }

  const ok = await comparePassword(String(otp).trim(), challenge.otp_hash);
  if (!ok) {
    const { rows: bumped } = await pool.query(
      'UPDATE login_otps SET attempts = attempts + 1 WHERE id = $1 RETURNING attempts',
      [challenge.id]
    );
    const left = Math.max(0, OTP_MAX_ATTEMPTS - bumped[0].attempts);
    return res.status(401).json({
      message: left > 0 ? `Incorrect code. ${left} attempt${left === 1 ? '' : 's'} left.` : 'Too many wrong attempts. Please sign in again.',
    });
  }

  const user = await userModel.findById(challenge.user_id, pool);
  if (!user || !user.is_active) {
    await pool.query('DELETE FROM login_otps WHERE id = $1', [challenge.id]);
    return res.status(403).json({ message: 'Account is deactivated. Contact your admin.' });
  }

  await pool.query('UPDATE login_otps SET consumed_at = now() WHERE id = $1', [challenge.id]);
  res.json(await buildLoginPayload(user, req));
});

/** POST /auth/resend-otp — body { pending_token }. Same challenge, fresh code (30s throttle). */
export const resendLoginOtp = asyncHandler(async (req, res) => {
  const { pending_token } = req.body;
  if (!pending_token) return res.status(400).json({ message: 'pending_token is required' });

  const { rows } = await pool.query('SELECT * FROM login_otps WHERE pending_token = $1 LIMIT 1', [String(pending_token)]);
  const challenge = rows[0];
  if (!challenge || challenge.consumed_at || new Date(challenge.expires_at) < new Date()) {
    return res.status(401).json({ message: 'This sign-in attempt is no longer valid. Please sign in again.' });
  }
  const sinceLastSend = (Date.now() - new Date(challenge.last_sent_at).getTime()) / 1000;
  if (sinceLastSend < OTP_RESEND_SECONDS) {
    return res.status(429).json({ message: `Please wait ${Math.ceil(OTP_RESEND_SECONDS - sinceLastSend)}s before requesting a new code` });
  }

  const user = await userModel.findById(challenge.user_id, pool);
  if (!user || !user.is_active) {
    return res.status(403).json({ message: 'Account is deactivated. Contact your admin.' });
  }

  const otp = String(crypto.randomInt(100000, 1000000));
  const otpHash = await hashPassword(otp);
  await pool.query(
    `UPDATE login_otps
        SET otp_hash = $1, attempts = 0, last_sent_at = now(),
            expires_at = now() + ($2 || ' minutes')::interval
      WHERE id = $3`,
    [otpHash, OTP_TTL_MINUTES, challenge.id]
  );
  try {
    await sendLoginOtpEmail({ to: user.email, name: user.name, otp, minutes: OTP_TTL_MINUTES });
  } catch (err) {
    console.error('[auth] OTP resend failed:', err.message);
    return res.status(502).json({ message: 'Could not send the verification email. Try again shortly.' });
  }
  res.json({ resent: true, email_hint: maskEmail(user.email), expires_in: OTP_TTL_MINUTES * 60 });
});

/**
 * POST /auth/refresh
 */
export const refresh = asyncHandler(async (req, res) => {
  const { refreshToken } = req.body;
  if (!refreshToken || typeof refreshToken !== 'string') {
    return res.status(401).json({ message: 'Invalid refresh token' });
  }

  let decoded;
  try {
    decoded = verifyToken(refreshToken, process.env.JWT_REFRESH_SECRET);
  } catch {
    return res.status(401).json({ message: 'Invalid refresh token' });
  }

  const user = await userModel.findById(decoded.id, pool);

  if (!user || user.token_version !== decoded.version) {
    if (user) await userModel.update(user.id, { token_version: user.token_version + 1, refresh_token: null }, pool);
    return res.status(401).json({ message: 'Invalid refresh token' });
  }

  if (!user.refresh_token || !(await comparePassword(refreshToken, user.refresh_token))) {
    await userModel.update(user.id, { token_version: user.token_version + 1, refresh_token: null }, pool);
    return res.status(401).json({ message: 'Invalid refresh token' });
  }

  const version = user.token_version;
  const accessToken = signAccessToken({ id: user.id, email: user.email, role: user.role, version });
  const newRefreshToken = signRefreshToken({ id: user.id, version });
  const hashedRefresh = await hashRefreshToken(newRefreshToken);
  await userModel.update(user.id, { refresh_token: hashedRefresh }, pool);

  res.json({ accessToken, refreshToken: newRefreshToken });
});

/**
 * POST /auth/logout
 */
export const logout = asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const { sessionId } = req.body; // Expect frontend to send the session ID

  await userModel.update(userId, { refresh_token: null }, pool);

  if (sessionId) {
    await pool.query(
      'UPDATE user_sessions SET logout_time = CURRENT_TIMESTAMP WHERE id = $1 AND user_id = $2',
      [sessionId, userId]
    );
  }

  res.json({ message: 'Logged out' });
});

/**
 * GET /auth/me
 * Get current user profile + accessible sites
 */
export const getMe = asyncHandler(async (req, res) => {
  const user = await userModel.findById(req.user.id, pool);
  if (!user) return res.status(404).json({ message: 'User not found' });

  let sites;
  if (user.role === 'admin' || user.role === 'super_admin') {
    sites = await siteModel.findAll(pool);
  } else {
    sites = await siteModel.findByUserId(user.id, pool);
  }

  // Fetch permissions for sub_admin
  let permissions = null;
  if (user.role === 'sub_admin') {
    permissions = await permissionModel.getByUserId(user.id);
  }

  res.json({ user: userModel.sanitize(user), sites, permissions });
});

/**
 * PUT /auth/profile
 */
export const updateProfile = asyncHandler(async (req, res) => {
  const { name, email, password, phone } = req.body;
  const userId = req.user.id;
  let updateData = {};

  if (name) updateData.name = name;
  if (email) updateData.email = email;
  if (phone !== undefined) updateData.phone = phone;
  if (password) updateData.password = await hashPassword(password);
  if (req.file) {
    const photoUrl = await uploadSingle(req.file, 'cloudinary');
    updateData.photo = photoUrl;
  }

  const updatedUser = await userModel.update(userId, updateData, pool);
  res.json({ user: userModel.sanitize(updatedUser) });
});

/**
 * PUT /auth/change-password
 * Securely change password (requires current password verification)
 */
export const changePassword = asyncHandler(async (req, res) => {
  const { currentPassword, newPassword, confirmPassword } = req.body;
  const userId = req.user.id;

  // Validate required fields
  if (!currentPassword || !newPassword || !confirmPassword) {
    return res.status(400).json({ message: 'All fields are required' });
  }

  // Validate new password length
  if (newPassword.length < 6) {
    return res.status(400).json({ message: 'New password must be at least 6 characters long' });
  }

  // Check passwords match
  if (newPassword !== confirmPassword) {
    return res.status(400).json({ message: 'New password and confirm password do not match' });
  }

  // Fetch user with password hash
  const user = await userModel.findById(userId, pool);
  if (!user) {
    return res.status(404).json({ message: 'User not found' });
  }

  // Verify current password
  const isMatch = await comparePassword(currentPassword, user.password);
  if (!isMatch) {
    return res.status(401).json({ message: 'Current password is incorrect' });
  }

  // Don't allow same password
  if (currentPassword === newPassword) {
    return res.status(400).json({ message: 'New password must be different from current password' });
  }

  // Hash and update
  const hashedPassword = await hashPassword(newPassword);
  await userModel.update(userId, { password: hashedPassword }, pool);

  res.json({ message: 'Password updated successfully' });
});