import asyncHandler from '../utils/asyncHandler.js';
import { hashPassword } from '../config/jwt.js';
import userModel from '../models/User.model.js';
import siteModel from '../models/Site.model.js';
import pool from '../config/db.js';

/**
 * POST /admin/sub-admins
 * Create a new sub-admin (admin only)
 */
export const createSubAdmin = asyncHandler(async (req, res) => {
  const { name, email, password, phone } = req.body;

  if (!name || !email || !password) {
    return res.status(400).json({ message: 'Name, email and password are required' });
  }

  const existing = await userModel.findByEmail(email, pool);
  if (existing) return res.status(400).json({ message: 'User with this email already exists' });

  const hashedPassword = await hashPassword(password);

  const userData = {
    name,
    email,
    password: hashedPassword,
    phone: phone || null,
    role: 'sub_admin',
    created_by: req.user.id,
    is_active: true,
    token_version: 1,
  };

  const user = await userModel.create(userData, pool);

  // If site_ids provided, assign them
  if (req.body.site_ids && Array.isArray(req.body.site_ids)) {
    for (const siteId of req.body.site_ids) {
      await siteModel.assignUser(siteId, user.id, pool);
    }
  }

  res.status(201).json({ user: userModel.sanitize(user) });
});

/**
 * GET /admin/sub-admins
 * List all sub-admins under the current admin
 */
export const listSubAdmins = asyncHandler(async (req, res) => {
  const subAdmins = await userModel.findSubAdminsByCreator(req.user.id, pool);

  // Attach assigned site IDs for each sub-admin
  const result = await Promise.all(
    subAdmins.map(async (sa) => {
      const siteIds = await userModel.getAssignedSiteIds(sa.id, pool);
      return { ...sa, site_ids: siteIds };
    })
  );

  res.json({ subAdmins: result });
});

/**
 * PUT /admin/sub-admins/:id
 * Update a sub-admin
 */
export const updateSubAdmin = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { name, email, phone, password, is_active, site_ids } = req.body;

  // Verify the sub-admin belongs to this admin
  const subAdmin = await userModel.findById(parseInt(id), pool);
  if (!subAdmin || subAdmin.created_by !== req.user.id) {
    return res.status(404).json({ message: 'Sub-admin not found' });
  }

  const updateData = {};
  if (name) updateData.name = name;
  if (email) updateData.email = email;
  if (phone !== undefined) updateData.phone = phone;
  if (password) updateData.password = await hashPassword(password);
  if (typeof is_active === 'boolean') updateData.is_active = is_active;

  let updatedUser = subAdmin;
  if (Object.keys(updateData).length > 0) {
    updatedUser = await userModel.update(parseInt(id), updateData, pool);
  }

  // Update site assignments if provided
  if (site_ids && Array.isArray(site_ids)) {
    // Remove all current assignments
    await pool.query('DELETE FROM user_sites WHERE user_id = $1', [parseInt(id)]);
    // Add new ones
    for (const siteId of site_ids) {
      await siteModel.assignUser(siteId, parseInt(id), pool);
    }
  }

  const siteIdsResult = await userModel.getAssignedSiteIds(parseInt(id), pool);
  res.json({ user: { ...userModel.sanitize(updatedUser), site_ids: siteIdsResult } });
});

/**
 * DELETE /admin/sub-admins/:id
 * Deactivate a sub-admin (soft delete)
 */
export const deleteSubAdmin = asyncHandler(async (req, res) => {
  const { id } = req.params;

  const subAdmin = await userModel.findById(parseInt(id), pool);
  if (!subAdmin || subAdmin.created_by !== req.user.id) {
    return res.status(404).json({ message: 'Sub-admin not found' });
  }

  await userModel.update(parseInt(id), { is_active: false }, pool);
  res.json({ message: 'Sub-admin deactivated' });
});
