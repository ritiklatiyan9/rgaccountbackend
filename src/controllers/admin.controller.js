import asyncHandler from '../utils/asyncHandler.js';
import { hashPassword } from '../config/jwt.js';
import userModel from '../models/User.model.js';
import siteModel from '../models/Site.model.js';
import permissionModel from '../models/Permission.model.js';
import pool from '../config/db.js';
import { disconnectUserAppSockets } from '../config/socket.js';

const SUPPORTED_MANAGED_ROLES = ['admin', 'sub_admin'];

const normalizeRole = (role) => {
  const normalized = String(role || 'sub_admin').toLowerCase();
  return SUPPORTED_MANAGED_ROLES.includes(normalized) ? normalized : null;
};

/**
 * GET /admin/approvers?site_id=X
 * List users eligible for approval / assignment dropdowns.
 *   - Always: all active admins + super_admins (they can approve any site).
 *   - If site_id is given: also include active sub-admins assigned to that site.
 * Accessible to both admin and sub-admin users.
 */
export const listApprovers = asyncHandler(async (req, res) => {
  const { site_id } = req.query;
  const parsedSiteId = site_id ? parseInt(site_id) : null;

  const query = parsedSiteId
    ? `
      SELECT u.id, u.name, u.email, u.phone, u.role,
             COALESCE(NULLIF(TRIM(u.name), ''), u.email) AS full_name
      FROM users u
      WHERE u.is_active = true
        AND (
          u.role IN ('admin', 'super_admin')
          OR (
            u.role = 'sub_admin'
            AND EXISTS (SELECT 1 FROM user_sites us WHERE us.user_id = u.id AND us.site_id = $1)
          )
        )
      ORDER BY
        CASE u.role WHEN 'super_admin' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END,
        u.name ASC
    `
    : `
      SELECT id, name, email, phone, role,
             COALESCE(NULLIF(TRIM(name), ''), email) AS full_name
      FROM users
      WHERE is_active = true AND role IN ('admin', 'super_admin')
      ORDER BY name ASC
    `;

  const params = parsedSiteId ? [parsedSiteId] : [];
  const { rows } = await pool.query(query, params);
  res.json({ approvers: rows });
});

/**
 * POST /admin/sub-admins
 * Create a managed user (admin or sub-admin)
 */
export const createSubAdmin = asyncHandler(async (req, res) => {
  const { name, email, password, phone, role, site_ids } = req.body;

  if (!name || !email || !password) {
    return res.status(400).json({ message: 'Name, email and password are required' });
  }

  const normalizedRole = normalizeRole(role);
  if (!normalizedRole) {
    return res.status(400).json({ message: 'Role must be admin or sub_admin' });
  }

  const existing = await userModel.findByEmail(email, pool);
  if (existing) return res.status(400).json({ message: 'User with this email already exists' });

  const hashedPassword = await hashPassword(password);

  const userData = {
    name,
    email,
    password: hashedPassword,
    phone: phone || null,
    role: normalizedRole,
    created_by: req.user.id,
    is_active: true,
    token_version: 1,
  };

  const user = await userModel.create(userData, pool);

  if (normalizedRole === 'sub_admin') {
    // Seed module permissions for sub-admin users.
    await permissionModel.createDefaults(user.id);
  }

  if (Array.isArray(site_ids)) {
    for (const siteId of site_ids) {
      await siteModel.assignUser(siteId, user.id, pool);
    }
  }

  const assignedSiteIds = await userModel.getAssignedSiteIds(user.id, pool);
  res.status(201).json({ user: { ...userModel.sanitize(user), site_ids: assignedSiteIds } });
});

/**
 * GET /admin/sub-admins
 * List all managed users (admins + sub-admins). Excludes super_admin.
 */
export const listSubAdmins = asyncHandler(async (req, res) => {
  // Show all non-super_admin users
  const result = await pool.query(
    `SELECT id, name, email, phone, photo, role, is_active, can_login_accounts, can_login_booking, can_login_booking_accounts, created_at, updated_at
     FROM users
     WHERE role IN ('admin', 'sub_admin')
     ORDER BY created_at DESC`
  );
  const managedUsers = result.rows;

  const enriched = await Promise.all(
    managedUsers.map(async (u) => {
      const siteIds = await userModel.getAssignedSiteIds(u.id, pool);
      return { ...u, site_ids: siteIds };
    })
  );

  res.json({ subAdmins: enriched });
});

/**
 * PUT /admin/sub-admins/:id
 * Update a managed user
 */
export const updateSubAdmin = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { name, email, phone, password, is_active, site_ids, role } = req.body;

  const managedUser = await userModel.findById(parseInt(id, 10), pool);
  if (!managedUser || managedUser.role === 'super_admin') {
    return res.status(404).json({ message: 'Managed user not found' });
  }

  const updateData = {};
  if (role !== undefined) {
    const normalizedRole = normalizeRole(role);
    if (!normalizedRole) {
      return res.status(400).json({ message: 'Role must be admin or sub_admin' });
    }
    if (normalizedRole !== managedUser.role) {
      if (managedUser.id === req.user.id) {
        return res.status(400).json({ message: 'You cannot change your own role' });
      }
      updateData.role = normalizedRole;
      // Role is carried in the JWT, so end old sessions for it to apply at once.
      updateData.token_version = (managedUser.token_version || 1) + 1;
    }
  }

  if (email) {
    const clash = await userModel.findByEmail(email, pool);
    if (clash && clash.id !== managedUser.id) {
      return res.status(400).json({ message: 'Another user already uses this email' });
    }
    updateData.email = String(email).trim();
  }
  if (name) updateData.name = name;
  if (phone !== undefined) updateData.phone = phone;
  if (password) updateData.password = await hashPassword(password);
  if (typeof is_active === 'boolean') updateData.is_active = is_active;

  let updatedUser = managedUser;
  if (Object.keys(updateData).length > 0) {
    updatedUser = await userModel.update(parseInt(id, 10), updateData, pool);
  }
  if (updateData.role === 'sub_admin') await permissionModel.createDefaults(managedUser.id);

  if (Array.isArray(site_ids)) {
    await pool.query('DELETE FROM user_sites WHERE user_id = $1', [parseInt(id, 10)]);
    for (const siteId of site_ids) {
      await siteModel.assignUser(siteId, parseInt(id, 10), pool);
    }
  }

  const siteIdsResult = await userModel.getAssignedSiteIds(parseInt(id, 10), pool);
  res.json({ user: { ...userModel.sanitize(updatedUser), site_ids: siteIdsResult } });
});

/**
 * DELETE /admin/sub-admins/:id
 * Deactivate a managed user
 */
export const deleteSubAdmin = asyncHandler(async (req, res) => {
  const { id } = req.params;

  const managedUser = await userModel.findById(parseInt(id, 10), pool);
  if (!managedUser || managedUser.role === 'super_admin') {
    return res.status(404).json({ message: 'Managed user not found' });
  }

  await userModel.update(parseInt(id, 10), { is_active: false }, pool);
  res.json({ message: 'Managed user deactivated' });
});

/**
 * PATCH /admin/sub-admins/:id/access
 * Body: any of { is_active, can_login_accounts, can_login_booking, can_login_booking_accounts }.
 * App grants are independent; is_active blocks the ID everywhere.
 */
const ACCESS_FIELDS = ['is_active', 'can_login_accounts', 'can_login_booking', 'can_login_booking_accounts'];

export const updateManagedUserAccess = asyncHandler(async (req, res) => {
  const targetUserId = parseInt(req.params.id, 10);

  if (!Number.isInteger(targetUserId)) {
    return res.status(400).json({ message: 'Invalid user id' });
  }

  const updates = {};
  for (const field of ACCESS_FIELDS) {
    if (req.body[field] === undefined) continue;
    if (typeof req.body[field] !== 'boolean') {
      return res.status(400).json({ message: `${field} must be boolean` });
    }
    updates[field] = req.body[field];
  }
  if (!Object.keys(updates).length) {
    return res.status(400).json({ message: `Send one of ${ACCESS_FIELDS.join(', ')}` });
  }

  if (targetUserId === req.user.id) {
    return res.status(400).json({ message: 'You cannot change your own access from this screen' });
  }

  const managedUser = await userModel.findById(targetUserId, pool);
  if (!managedUser || managedUser.role === 'super_admin') {
    return res.status(404).json({ message: 'Managed user not found' });
  }

  const updated = await userModel.update(targetUserId, updates, pool);

  // Per-app revocation is checked on every request. Do not end another app
  // session: both Accounts frontends can use the shared session table.
  if (updates.is_active === false) {
    await pool.query(
      'UPDATE user_sessions SET logout_time = CURRENT_TIMESTAMP WHERE user_id = $1 AND logout_time IS NULL',
      [targetUserId]
    );
  }

  if (updates.is_active === false) disconnectUserAppSockets(targetUserId);
  else {
    if (updates.can_login_accounts === false) disconnectUserAppSockets(targetUserId, 'accounts');
    if (updates.can_login_booking_accounts === false) disconnectUserAppSockets(targetUserId, 'booking_accounts');
  }

  const message = updates.is_active === undefined
    ? 'Login access updated'
    : updates.is_active ? 'User unblocked successfully' : 'User blocked successfully';
  res.json({ user: userModel.sanitize(updated), message });
});

// Rows that only describe the login itself; they are removed with the user
// (all ON DELETE CASCADE). Any other row pointing at the user is history.
const LOGIN_ONLY_TABLES = new Set([
  'user_sites', 'user_permissions', 'user_sessions', 'user_approval_modules',
  'dashboard_component_permissions', 'user_home_layouts', 'login_otps',
  'user_push_tokens', 'booking_staff_identities', 'booking_user_kyc_links',
  'seek_permission_access',
]);

/**
 * DELETE /admin/sub-admins/:id/permanent
 * Hard-deletes an ID that has never touched data. Many FKs to users CASCADE
 * (imprest ledger, chats) or SET NULL (created_by/approved_by on every money
 * table), so deleting an ID with history would silently erase or orphan it —
 * those are refused with 409 and should be blocked instead.
 */
export const permanentlyDeleteManagedUser = asyncHandler(async (req, res) => {
  const targetUserId = parseInt(req.params.id, 10);
  if (!Number.isInteger(targetUserId)) {
    return res.status(400).json({ message: 'Invalid user id' });
  }
  if (targetUserId === req.user.id) {
    return res.status(400).json({ message: 'You cannot delete your own ID' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // FOR UPDATE also blocks new rows referencing this user until we finish.
    const { rows: [user] } = await client.query(
      "SELECT id, name, role FROM users WHERE id = $1 AND role IN ('admin', 'sub_admin') FOR UPDATE",
      [targetUserId]
    );
    if (!user) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Managed user not found' });
    }

    // ponytail: one EXISTS probe per FK column (~280, some unindexed) — fine for a rare admin action.
    const { rows: refs } = await client.query(`
      SELECT c.conrelid::regclass::text AS tbl,
             format('SELECT %L AS tbl WHERE EXISTS (SELECT 1 FROM %s WHERE %I = $1)',
                    c.conrelid::regclass::text, c.conrelid::regclass, a.attname) AS probe
        FROM pg_constraint c
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
       WHERE c.contype = 'f' AND c.confrelid = 'users'::regclass`);
    const probes = refs.filter((r) => !LOGIN_ONLY_TABLES.has(r.tbl)).map((r) => r.probe);
    const { rows: used } = probes.length
      ? await client.query(probes.join(' UNION ALL '), [targetUserId])
      : { rows: [] };

    if (used.length) {
      await client.query('ROLLBACK');
      const tables = [...new Set(used.map((r) => r.tbl.replace(/_/g, ' ')))];
      return res.status(409).json({
        message: `${user.name} (#${user.id}) has records in ${tables.slice(0, 5).join(', ')}${tables.length > 5 ? ` and ${tables.length - 5} more` : ''}. IDs with history cannot be deleted — block it instead.`,
        tables,
      });
    }

    await client.query('DELETE FROM users WHERE id = $1', [targetUserId]);
    await client.query('COMMIT');
    res.json({ message: `${user.name} (#${user.id}) deleted permanently` });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
});

/**
 * POST /admin/sub-admins/:id/reset-password
 * Reset/change password for managed user by admin.
 */
export const resetManagedUserPassword = asyncHandler(async (req, res) => {
  const targetUserId = parseInt(req.params.id, 10);
  const { new_password } = req.body;

  if (!Number.isInteger(targetUserId)) {
    return res.status(400).json({ message: 'Invalid user id' });
  }

  if (targetUserId === req.user.id) {
    return res.status(400).json({ message: 'Use profile settings to change your own password' });
  }

  if (!new_password || String(new_password).length < 6) {
    return res.status(400).json({ message: 'new_password must be at least 6 characters' });
  }

  const managedUser = await userModel.findById(targetUserId, pool);
  if (!managedUser || managedUser.role === 'super_admin') {
    return res.status(404).json({ message: 'Managed user not found' });
  }

  const hashedPassword = await hashPassword(new_password);

  // Rotate token version and clear refresh token to force fresh login on all devices.
  const updated = await userModel.update(targetUserId, {
    password: hashedPassword,
    refresh_token: null,
    token_version: (managedUser.token_version || 1) + 1,
  }, pool);

  await pool.query(
    'UPDATE user_sessions SET logout_time = CURRENT_TIMESTAMP WHERE user_id = $1 AND logout_time IS NULL',
    [targetUserId]
  );

  res.json({ user: userModel.sanitize(updated), message: 'Password reset successfully. User must login again.' });
});

// ══════════════════════════════════════════════════
//  APPROVAL MANAGER ENDPOINTS
// ══════════════════════════════════════════════════

/**
 * All approval module keys (must match ALLOWED_TABLES keys in approval.controller)
 */
const APPROVAL_MODULES = [
  'farmer_payment',
  'plot_commission',
  'plot_commission_payment',
  'cash_flow_entry',
  'firm_transaction',
  'plot_payment',
  'expense',
  'daybook',
  // Modules that reach the approval queue but had no grantable entry, so a
  // sub-admin could only ever see rows assigned to them one by one.
  'misc_income_entry',
  'vendor_payment',
  'plot_registry_payment',
  'plot_installment_payment',
];

// Ensure the table exists (safe to call multiple times)
let _tableReady = false;
const ensureApprovalModulesTable = async () => {
  if (_tableReady) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_approval_modules (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      module VARCHAR(50) NOT NULL,
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(user_id, module)
    );
  `);
  _tableReady = true;
};

/**
 * GET /admin/approval-managers
 * List all admins + sub-admins with their per-module approval permissions.
 */
export const listApprovalManagers = asyncHandler(async (_req, res) => {
  await ensureApprovalModulesTable();

  const usersResult = await pool.query(
    `SELECT u.id, u.name, u.email, u.phone, u.photo, u.role, u.is_active
     FROM users u
     WHERE u.role IN ('admin', 'sub_admin') AND u.is_active = true
     ORDER BY u.role ASC, u.name ASC`
  );

  const modulesResult = await pool.query(
    `SELECT user_id, module FROM user_approval_modules ORDER BY user_id`
  );

  // Build lookup: userId → Set of modules
  const moduleMap = {};
  for (const row of modulesResult.rows) {
    if (!moduleMap[row.user_id]) moduleMap[row.user_id] = [];
    moduleMap[row.user_id].push(row.module);
  }

  const managers = usersResult.rows.map(u => ({
    ...u,
    allowed_modules: moduleMap[u.id] || [],
  }));

  res.json({ managers, all_modules: APPROVAL_MODULES });
});

/**
 * PUT /admin/approval-managers/:userId
 * Update a sub-admin's allowed approval modules.
 * Body: { modules: ['farmer_payment', 'expense', ...] }
 */
export const updateApprovalManager = asyncHandler(async (req, res) => {
  await ensureApprovalModulesTable();

  const targetUserId = parseInt(req.params.userId, 10);
  const { modules } = req.body;

  if (!Number.isInteger(targetUserId)) {
    return res.status(400).json({ message: 'Invalid user id' });
  }
  if (!Array.isArray(modules)) {
    return res.status(400).json({ message: 'modules must be an array' });
  }

  const user = await userModel.findById(targetUserId, pool);
  if (!user || !['admin', 'sub_admin'].includes(user.role)) {
    return res.status(404).json({ message: 'User not found' });
  }

  // Validate modules
  const validModules = modules.filter(m => APPROVAL_MODULES.includes(m));

  // Replace all modules for this user in one transaction
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM user_approval_modules WHERE user_id = $1', [targetUserId]);
    for (const mod of validModules) {
      await client.query(
        'INSERT INTO user_approval_modules (user_id, module) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [targetUserId, mod]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  // Also update the expense_approval permission so sidebar/route gating works
  const hasAny = validModules.length > 0;
  await permissionModel.upsert(targetUserId, 'expense_approval', {
    can_read: hasAny,
    can_write: hasAny,
    can_update: hasAny,
    can_delete: false,
  });

  res.json({
    message: validModules.length > 0
      ? `${validModules.length} approval module(s) granted`
      : 'All approval modules revoked',
    modules: validModules,
  });
});
