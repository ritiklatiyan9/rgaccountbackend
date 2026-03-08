import asyncHandler from '../utils/asyncHandler.js';
import permissionModel from '../models/Permission.model.js';
import userModel from '../models/User.model.js';
import pool from '../config/db.js';

/**
 * GET /permissions/:userId
 * Get all permissions for a sub-admin (admin only)
 */
export const getPermissions = asyncHandler(async (req, res) => {
    const { userId } = req.params;

    // Verify user exists and is a sub_admin
    const user = await userModel.findById(parseInt(userId), pool);
    if (!user || user.role !== 'sub_admin') {
        return res.status(404).json({ message: 'Sub-admin not found' });
    }

    let permissions = await permissionModel.getByUserId(parseInt(userId));

    // If no permissions exist yet, create defaults
    if (permissions.length === 0) {
        permissions = await permissionModel.createDefaults(parseInt(userId));
    }

    res.json({ permissions });
});

/**
 * PUT /permissions/:userId
 * Bulk update permissions for a sub-admin (admin only)
 * Body: { permissions: [{ module, can_read, can_write, can_update, can_delete }] }
 */
export const updatePermissions = asyncHandler(async (req, res) => {
    const { userId } = req.params;
    const { permissions } = req.body;

    if (!permissions || !Array.isArray(permissions)) {
        return res.status(400).json({ message: 'permissions array is required' });
    }

    // Verify user exists and is a sub_admin
    const user = await userModel.findById(parseInt(userId), pool);
    if (!user || user.role !== 'sub_admin') {
        return res.status(404).json({ message: 'Sub-admin not found' });
    }

    const updated = await permissionModel.bulkUpsert(parseInt(userId), permissions);
    res.json({ permissions: updated, message: 'Permissions updated successfully' });
});
