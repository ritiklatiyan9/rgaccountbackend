/**
 * Dashboard Component Permissions Controller
 *
 * Manages which dashboard components each user (admin / sub-admin) can see.
 *
 * ALL_COMPONENTS — canonical list of dashboard component keys.
 * When a user has NO row for a component the default is allowed = true (open by default).
 * Admin / super_admin always see everything regardless of this table.
 */

import pool from '../config/db.js';
import asyncHandler from '../utils/asyncHandler.js';

import { ALL_COMPONENTS } from '../services/dashboardPermissions.service.js';
import { clearCacheByPrefixes } from '../config/cache.js';
export { ALL_COMPONENTS } from '../services/dashboardPermissions.service.js';

const parseUserId = value => /^\d+$/.test(String(value)) && Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : null;
const findManagedUser = async (req, res) => {
  const id = parseUserId(req.params.userId);
  if (!id) { res.status(400).json({ message: 'Invalid userId' }); return null; }
  const { rows } = await pool.query(
    'SELECT id, role FROM users WHERE id = $1 AND organization_id = $2 AND is_active = true',
    [id, req.user.organization_id],
  );
  if (!rows.length) { res.status(404).json({ message: 'Team member not found' }); return null; }
  return rows[0];
};

// GET /dashboard-permissions/:userId
// Returns the component permissions for any user (admin / sub-admin).
export const getDashboardPermissions = asyncHandler(async (req, res) => {
  const target = await findManagedUser(req, res);
  if (!target) return;
  const userId = target.id;

  const { rows } = await pool.query(
    `SELECT component, allowed
     FROM dashboard_component_permissions
     WHERE user_id = $1`,
    [userId]
  );

  // Build a full map; components not in DB default to allowed = true
  const map = {};
  for (const comp of ALL_COMPONENTS) map[comp] = true;
  for (const row of rows) map[row.component] = row.allowed;

  res.json({ userId, permissions: map });
});

// GET /dashboard-permissions/me — used by the logged-in user themselves
export const getMyDashboardPermissions = asyncHandler(async (req, res) => {
  const userId = req.user.id;

  const { rows } = await pool.query(
    `SELECT component, allowed
     FROM dashboard_component_permissions
     WHERE user_id = $1`,
    [userId]
  );

  const map = {};
  for (const comp of ALL_COMPONENTS) map[comp] = true;
  for (const row of rows) map[row.component] = row.allowed;

  res.json({ userId, permissions: map });
});

// PUT /dashboard-permissions/:userId
// Body: { permissions: { kpi_profit: true, revenue_charts: false, ... } }
export const updateDashboardPermissions = asyncHandler(async (req, res) => {
  const target = await findManagedUser(req, res);
  if (!target) return;
  const userId = target.id;

  const { permissions } = req.body;
  if (!permissions || typeof permissions !== 'object' || Array.isArray(permissions)) {
    return res.status(400).json({ message: 'permissions object is required' });
  }

  if (['admin', 'super_admin'].includes(target.role)) {
    return res.status(400).json({ message: 'Admins inherit full dashboard access from their role' });
  }
  if (Object.values(permissions).some(value => typeof value !== 'boolean')) {
    return res.status(400).json({ message: 'Every component permission must be a boolean' });
  }

  // Validate keys
  const invalid = Object.keys(permissions).filter(k => !ALL_COMPONENTS.includes(k));
  if (invalid.length > 0) {
    return res.status(400).json({ message: `Unknown component(s): ${invalid.join(', ')}` });
  }

  // Upsert each entry
  const entries = Object.entries(permissions);
  if (entries.length === 0) {
    return res.json({ message: 'No changes' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const [component, allowed] of entries) {
      await client.query(
        `INSERT INTO dashboard_component_permissions (user_id, component, allowed, updated_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (user_id, component) DO UPDATE
           SET allowed = EXCLUDED.allowed, updated_at = NOW()`,
        [userId, component, allowed]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  await clearCacheByPrefixes(['dash-perms-me|']);

  // Return updated full map
  const { rows } = await pool.query(
    `SELECT component, allowed FROM dashboard_component_permissions WHERE user_id = $1`,
    [userId]
  );
  const map = {};
  for (const comp of ALL_COMPONENTS) map[comp] = true;
  for (const row of rows) map[row.component] = row.allowed;

  res.json({ userId, permissions: map, message: 'Dashboard permissions updated' });
});

// GET /dashboard-permissions/users — list all users (admin + sub-admin) with their component counts
export const listUsersWithDashboardPermissions = asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT
       u.id, u.name, u.email, u.role,
       COUNT(dcp.component) FILTER (WHERE dcp.allowed = false) AS restricted_count
     FROM users u
     LEFT JOIN dashboard_component_permissions dcp ON dcp.user_id = u.id
     WHERE u.role IN ('admin', 'super_admin', 'sub_admin') AND u.is_active = true AND u.organization_id = $1
     GROUP BY u.id, u.name, u.email, u.role
     ORDER BY u.role, u.name`,
    [req.user.organization_id],
  );
  res.json({ users: rows });
});
