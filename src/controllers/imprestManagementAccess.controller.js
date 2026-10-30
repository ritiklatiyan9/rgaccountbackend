import pool from '../config/db.js';
import asyncHandler from '../utils/asyncHandler.js';
import { getImprestManagementSettings, saveImprestManagementSettings } from '../services/imprestManagementAccess.service.js';

export const getManagementSettings = asyncHandler(async (req, res) => {
  res.set('Cache-Control', 'private, no-store');
  res.json(await getImprestManagementSettings(pool, req.user, req.query.site_id));
});
export const saveManagementSettings = asyncHandler(async (req, res) => {
  const setting = await saveImprestManagementSettings(pool, req.user, req.params.userId, req.body);
  res.json({ ...setting, message: 'Imprest Management access saved' });
});
