import asyncHandler from '../utils/asyncHandler.js';
import { hashPassword } from '../config/jwt.js';
import userModel from '../models/User.model.js';
import siteModel from '../models/Site.model.js';
import permissionModel from '../models/Permission.model.js';
import pool from '../config/db.js';

const SUPPORTED_MANAGED_ROLES = ['admin', 'sub_admin'];

const normalizeRole = (role) => {
  const normalized = String(role || 'sub_admin').toLowerCase();
  return SUPPORTED_MANAGED_ROLES.includes(normalized) ? normalized : null;
};

/**
 * GET /admin/approvers
 * List active admins for assignment dropdowns.
 * Accessible to both admin and sub-admin users.
 */
export const listApprovers = asyncHandler(async (_req, res) => {
  const approvers = await userModel.findActiveAdmins(pool);
  res.json({ approvers });
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
 * List all managed users under the current admin
 */
export const listSubAdmins = asyncHandler(async (req, res) => {
  const managedUsers = await userModel.findManagedUsersByCreator(req.user.id, pool);

  const result = await Promise.all(
    managedUsers.map(async (managedUser) => {
      const siteIds = await userModel.getAssignedSiteIds(managedUser.id, pool);
      return { ...managedUser, site_ids: siteIds };
    })
  );

  res.json({ subAdmins: result });
});

/**
 * PUT /admin/sub-admins/:id
 * Update a managed user
 */
export const updateSubAdmin = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { name, email, phone, password, is_active, site_ids, role } = req.body;

  const managedUser = await userModel.findById(parseInt(id, 10), pool);
  if (!managedUser || managedUser.created_by !== req.user.id) {
    return res.status(404).json({ message: 'Managed user not found' });
  }

  if (role !== undefined) {
    const normalizedRole = normalizeRole(role);
    if (!normalizedRole) {
      return res.status(400).json({ message: 'Role must be admin or sub_admin' });
    }
  }

  const updateData = {};
  if (name) updateData.name = name;
  if (email) updateData.email = email;
  if (phone !== undefined) updateData.phone = phone;
  if (password) updateData.password = await hashPassword(password);
  if (typeof is_active === 'boolean') updateData.is_active = is_active;
  if (role !== undefined) updateData.role = normalizeRole(role);

  let updatedUser = managedUser;
  if (Object.keys(updateData).length > 0) {
    updatedUser = await userModel.update(parseInt(id, 10), updateData, pool);
  }

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
  if (!managedUser || managedUser.created_by !== req.user.id) {
    return res.status(404).json({ message: 'Managed user not found' });
  }

  await userModel.update(parseInt(id, 10), { is_active: false }, pool);
  res.json({ message: 'Managed user deactivated' });
});

/**
 * PATCH /admin/sub-admins/:id/access
 * Block or unblock managed user access.
 */
export const updateManagedUserAccess = asyncHandler(async (req, res) => {
  const targetUserId = parseInt(req.params.id, 10);
  const { is_active } = req.body;

  if (!Number.isInteger(targetUserId)) {
    return res.status(400).json({ message: 'Invalid user id' });
  }

  if (typeof is_active !== 'boolean') {
    return res.status(400).json({ message: 'is_active must be boolean' });
  }

  if (targetUserId === req.user.id) {
    return res.status(400).json({ message: 'You cannot change your own access from this screen' });
  }

  const managedUser = await userModel.findById(targetUserId, pool);
  if (!managedUser || managedUser.created_by !== req.user.id) {
    return res.status(404).json({ message: 'Managed user not found' });
  }

  const updated = await userModel.update(targetUserId, { is_active }, pool);

  // If blocked, close active sessions immediately.
  if (!is_active) {
    await pool.query(
      'UPDATE user_sessions SET logout_time = CURRENT_TIMESTAMP WHERE user_id = $1 AND logout_time IS NULL',
      [targetUserId]
    );
  }

  res.json({ user: userModel.sanitize(updated), message: is_active ? 'User unblocked successfully' : 'User blocked successfully' });
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
  if (!managedUser || managedUser.created_by !== req.user.id) {
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
