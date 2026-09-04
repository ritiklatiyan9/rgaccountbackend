import asyncHandler from '../utils/asyncHandler.js';
import pool from '../config/db.js';
import { inventoryModel } from '../models/Inventory.model.js';

const num = (v) => (v === undefined || v === null || v === '' ? null : Number(v));
const asId = (v) => {
  const id = Number.parseInt(v, 10);
  return Number.isInteger(id) && id > 0 ? id : null;
};
const requireSite = (req, res) => {
  const siteId = parseInt(req.query.site_id || req.body.site_id, 10);
  if (!siteId) { res.status(400).json({ message: 'site_id is required' }); return null; }
  return siteId;
};

const PROJECT_TYPES = new Set([
  'GENERAL', 'STUDIO_APARTMENTS', 'APARTMENTS', 'FLATS', 'PLOTTED_DEVELOPMENT',
  'MIXED_USE', 'INFRASTRUCTURE', 'RENOVATION',
]);
const PROJECT_STATUSES = new Set(['PLANNING', 'ACTIVE', 'ON_HOLD', 'DELAYED', 'COMPLETED', 'CANCELLED']);
const TASK_STATUSES = new Set(['PENDING', 'IN_PROGRESS', 'BLOCKED', 'DONE']);
const REQUEST_STATUSES = new Set(['DRAFT', 'REQUESTED', 'PARTIALLY_FULFILLED', 'FULFILLED', 'CANCELLED']);
const LOCATION_TYPES = new Set([
  'SITE', 'PHASE', 'TOWER', 'BLOCK', 'FLOOR', 'UNIT', 'FLAT', 'STUDIO',
  'PLOT', 'VILLA', 'ZONE', 'AMENITY',
]);
const LOCATION_STATUSES = new Set(['PLANNED', 'ACTIVE', 'ON_HOLD', 'COMPLETED']);

const normalizeProjectType = (value) => {
  const type = String(value || 'GENERAL').trim().toUpperCase();
  return PROJECT_TYPES.has(type) ? type : null;
};
const normalizeLocationType = (value) => {
  const type = String(value || 'ZONE').trim().toUpperCase();
  return LOCATION_TYPES.has(type) ? type : null;
};
const getScopedProject = async (projectId, siteId, client = pool) => {
  const { rows } = await client.query(
    'SELECT * FROM construction_projects WHERE id = $1 AND site_id = $2',
    [projectId, siteId]
  );
  return rows[0] || null;
};
const locationBelongsToProject = async (locationId, projectId, client = pool) => {
  if (!locationId) return true;
  const { rows } = await client.query(
    'SELECT 1 FROM construction_locations WHERE id = $1 AND project_id = $2',
    [locationId, projectId]
  );
  return Boolean(rows[0]);
};

// Recompute a request's status from its line items (CANCELLED stays sticky).
const deriveRequestStatus = (items) => {
  const anyIssued = items.some((i) => Number(i.qty_issued) > 0);
  const allFilled = items.every((i) => Number(i.qty_issued) >= Number(i.qty_requested));
  if (allFilled) return 'FULFILLED';
  if (anyIssued) return 'PARTIALLY_FULFILLED';
  return 'REQUESTED';
};

// ── Projects ────────────────────────────────────────────────

export const listProjects = asyncHandler(async (req, res) => {
  const siteId = requireSite(req, res); if (!siteId) return;
  const params = [siteId];
  let where = 'WHERE p.site_id = $1';
  if (req.query.status && req.query.status !== 'all') { params.push(req.query.status.toUpperCase()); where += ` AND p.status = $${params.length}`; }
  if (req.query.project_type && req.query.project_type !== 'all') { params.push(req.query.project_type.toUpperCase()); where += ` AND p.project_type = $${params.length}`; }
  if (req.query.search?.trim()) { params.push(`%${req.query.search.trim()}%`); where += ` AND (p.name ILIKE $${params.length} OR p.code ILIKE $${params.length})`; }
  const { rows } = await pool.query(
    `SELECT p.*,
       aa.name AS assigned_admin_name,
       COALESCE(t.task_count, 0)::int         AS task_count,
       COALESCE(t.done_count, 0)::int         AS done_task_count,
       COALESCE(c.actual_cost, 0)             AS actual_cost,
       COALESCE(r.pending_requests, 0)::int   AS pending_requests,
       COALESCE(l.location_count, 0)::int     AS location_count,
       COALESCE(l.completed_locations, 0)::int AS completed_location_count,
       COALESCE(v.vendor_count, 0)::int       AS vendor_commitment_count,
       COALESCE(v.committed_value, 0)         AS committed_value,
       (p.target_end_date IS NOT NULL AND p.target_end_date < CURRENT_DATE AND p.status <> 'COMPLETED') AS is_overdue
     FROM construction_projects p
     LEFT JOIN users aa ON aa.id = p.assigned_admin_id
     LEFT JOIN (SELECT t2.project_id, COUNT(*) task_count, COUNT(*) FILTER (WHERE t2.status='DONE') done_count
                  FROM construction_tasks t2 JOIN construction_projects sp ON sp.id = t2.project_id
                 WHERE sp.site_id = $1 GROUP BY t2.project_id) t ON t.project_id = p.id
     LEFT JOIN (SELECT mv.project_id, SUM(mv.qty*mv.rate) actual_cost
                  FROM inventory_movements mv
                 WHERE mv.site_id = $1 AND mv.movement_type='CONSUMPTION' GROUP BY mv.project_id) c ON c.project_id = p.id
     LEFT JOIN (SELECT mr.project_id, COUNT(*) pending_requests
                  FROM construction_material_requests mr
                 WHERE mr.site_id = $1 AND mr.status IN ('REQUESTED','PARTIALLY_FULFILLED') GROUP BY mr.project_id) r ON r.project_id = p.id
     LEFT JOIN (SELECT l2.project_id, COUNT(*) location_count, COUNT(*) FILTER (WHERE l2.status='COMPLETED') completed_locations
                  FROM construction_locations l2 JOIN construction_projects sp ON sp.id = l2.project_id
                 WHERE sp.site_id = $1 GROUP BY l2.project_id) l ON l.project_id = p.id
     LEFT JOIN (SELECT vc.project_id, COUNT(*) vendor_count, SUM(vc.contract_amount) committed_value
                  FROM vendor_commitments vc
                 WHERE vc.site_id = $1 AND vc.project_id IS NOT NULL AND vc.status <> 'cancelled' GROUP BY vc.project_id) v ON v.project_id = p.id
     ${where}
     ORDER BY p.created_at DESC`,
    params
  );
  res.json({ projects: rows });
});

export const createProject = asyncHandler(async (req, res) => {
  const siteId = requireSite(req, res); if (!siteId) return;
  const { name, code, status, start_date, target_end_date, budget, notes, assigned_admin_id } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ message: 'Project name is required' });
  const projectType = normalizeProjectType(req.body.project_type);
  const projectStatus = String(status || 'PLANNING').toUpperCase();
  if (!projectType) return res.status(400).json({ message: 'Invalid project type' });
  if (!PROJECT_STATUSES.has(projectStatus)) return res.status(400).json({ message: 'Invalid project status' });
  const { rows } = await pool.query(
    `INSERT INTO construction_projects (site_id, name, code, project_type, status, start_date, target_end_date, budget, notes, assigned_admin_id, created_by)
     VALUES ($1,$2,$3,$4,COALESCE($5,'PLANNING'),$6,$7,$8,$9,$10,$11) RETURNING *`,
    [siteId, name.trim(), code?.trim() || null, projectType, projectStatus,
     start_date || null, target_end_date || null, num(budget) || 0, notes?.trim() || null,
     assigned_admin_id || null, req.user.id]
  );
  res.status(201).json({ project: rows[0] });
});

export const getProject = asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const siteId = requireSite(req, res); if (!siteId) return;
  const { rows } = await pool.query(
    `SELECT p.*, aa.name AS assigned_admin_name
       FROM construction_projects p
       LEFT JOIN users aa ON aa.id = p.assigned_admin_id
      WHERE p.id = $1 AND p.site_id = $2`,
    [id, siteId]
  );
  const project = rows[0];
  if (!project) return res.status(404).json({ message: 'Project not found' });

  const [tasks, requests, cost, locations, commitments, locationCosts] = await Promise.all([
    pool.query(`SELECT t.*, l.name AS location_name, l.location_type
                  FROM construction_tasks t
                  LEFT JOIN construction_locations l ON l.id = t.location_id
                 WHERE t.project_id = $1 ORDER BY t.sequence ASC, t.id ASC`, [id]),
    pool.query(
      `SELECT r.*, u.name AS requested_by_name, l.name AS location_name, l.location_type,
         COALESCE(json_agg(json_build_object(
           'id', ri.id, 'material_id', ri.material_id, 'material_name', m.name, 'unit', m.unit,
           'qty_requested', ri.qty_requested, 'qty_issued', ri.qty_issued,
           'qty_shortage', GREATEST(ri.qty_requested - ri.qty_issued, 0)
         ) ORDER BY ri.id) FILTER (WHERE ri.id IS NOT NULL), '[]') AS items
       FROM construction_material_requests r
       LEFT JOIN construction_material_request_items ri ON ri.request_id = r.id
       LEFT JOIN inventory_materials m ON m.id = ri.material_id
       LEFT JOIN users u ON u.id = r.requested_by
       LEFT JOIN construction_locations l ON l.id = r.location_id
       WHERE r.project_id = $1
       GROUP BY r.id, u.name, l.name, l.location_type
       ORDER BY r.created_at DESC`,
      [id]
    ),
    pool.query(`SELECT COALESCE(SUM(qty*rate),0) AS actual_cost FROM inventory_movements WHERE movement_type='CONSUMPTION' AND project_id = $1`, [id]),
    pool.query(
      `WITH RECURSIVE tree AS (
         SELECT l.*, l.name::text AS path, 0 AS depth
           FROM construction_locations l
          WHERE l.project_id = $1 AND l.parent_id IS NULL
         UNION ALL
         SELECT child.*, (tree.path || ' / ' || child.name)::text, tree.depth + 1
           FROM construction_locations child JOIN tree ON tree.id = child.parent_id
       )
       SELECT * FROM tree ORDER BY path, sequence, id`,
      [id]
    ),
    pool.query(
      `SELECT vc.id, vc.vendor_name, vc.work_title, vc.head_name, vc.contract_amount,
              vc.status, vc.due_date, vc.location_id, l.name AS location_name,
              COALESCE(SUM(vp.amount) FILTER (WHERE financial_transaction_posts('debit', vp.status, vp.payment_mode, vp.cheque_status)), 0)::numeric(14,2) AS paid_amount
         FROM vendor_commitments vc
         LEFT JOIN vendor_payments vp ON vp.commitment_id = vc.id
         LEFT JOIN construction_locations l ON l.id = vc.location_id
        WHERE vc.project_id = $1
        GROUP BY vc.id, l.name
        ORDER BY vc.status = 'open' DESC, vc.due_date NULLS LAST, vc.id DESC`,
      [id]
    ),
    pool.query(
      `SELECT mv.location_id, l.name AS location_name,
              COALESCE(SUM(mv.qty * mv.rate), 0)::numeric(15,2) AS actual_cost
         FROM inventory_movements mv
         LEFT JOIN construction_locations l ON l.id = mv.location_id
        WHERE mv.project_id = $1 AND mv.movement_type = 'CONSUMPTION'
        GROUP BY mv.location_id, l.name ORDER BY actual_cost DESC`,
      [id]
    ),
  ]);

  res.json({
    project: { ...project, actual_cost: parseFloat(cost.rows[0].actual_cost) || 0 },
    tasks: tasks.rows,
    material_requests: requests.rows,
    locations: locations.rows,
    vendor_commitments: commitments.rows,
    location_costs: locationCosts.rows,
  });
});

export const updateProject = asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const siteId = requireSite(req, res); if (!siteId) return;
  const fields = ['name', 'code', 'project_type', 'status', 'start_date', 'target_end_date', 'actual_end_date', 'budget', 'progress_pct', 'notes', 'assigned_admin_id'];
  const sets = [];
  const params = [];
  for (const f of fields) {
    if (req.body[f] === undefined) continue;
    let v = req.body[f];
    if (f === 'status') {
      v = String(v).toUpperCase();
      if (!PROJECT_STATUSES.has(v)) return res.status(400).json({ message: 'Invalid project status' });
    }
    else if (f === 'project_type') {
      v = normalizeProjectType(v);
      if (!v) return res.status(400).json({ message: 'Invalid project type' });
    }
    else if (f === 'budget') v = num(v) || 0;
    else if (f === 'progress_pct') v = Math.max(0, Math.min(100, parseInt(v, 10) || 0));
    else if (['start_date', 'target_end_date', 'actual_end_date', 'assigned_admin_id'].includes(f)) v = v || null;
    else v = v === null ? null : String(v).trim() || null;
    params.push(v);
    sets.push(`${f} = $${params.length}`);
  }
  if (sets.length === 0) return res.status(400).json({ message: 'Nothing to update' });
  params.push(id, siteId);
  const { rows } = await pool.query(
    `UPDATE construction_projects SET ${sets.join(', ')}, updated_at = NOW()
      WHERE id = $${params.length - 1} AND site_id = $${params.length} RETURNING *`,
    params
  );
  if (!rows[0]) return res.status(404).json({ message: 'Project not found' });
  res.json({ project: rows[0] });
});

export const deleteProject = asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const siteId = requireSite(req, res); if (!siteId) return;
  const del = await pool.query('DELETE FROM construction_projects WHERE id = $1 AND site_id = $2 RETURNING id', [id, siteId]);
  if (!del.rows[0]) return res.status(404).json({ message: 'Project not found' });
  res.json({ success: true });
});

// ── Project structure (phase / tower / floor / flat / plot / zone) ─────────

export const createLocation = asyncHandler(async (req, res) => {
  const projectId = asId(req.params.id);
  const siteId = requireSite(req, res); if (!siteId) return;
  const project = await getScopedProject(projectId, siteId);
  if (!project) return res.status(404).json({ message: 'Project not found' });

  const name = String(req.body.name || '').trim();
  const locationType = normalizeLocationType(req.body.location_type);
  const parentId = asId(req.body.parent_id);
  if (!name) return res.status(400).json({ message: 'Location name is required' });
  if (!locationType) return res.status(400).json({ message: 'Invalid location type' });
  if (parentId && !(await locationBelongsToProject(parentId, projectId))) {
    return res.status(400).json({ message: 'Parent location does not belong to this project' });
  }

  const status = String(req.body.status || 'PLANNED').toUpperCase();
  if (!LOCATION_STATUSES.has(status)) return res.status(400).json({ message: 'Invalid location status' });
  const { rows } = await pool.query(
    `INSERT INTO construction_locations
       (project_id, parent_id, location_type, name, code, status, progress_pct, sequence, area_sqft, notes, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [projectId, parentId, locationType, name, String(req.body.code || '').trim() || null, status,
     Math.max(0, Math.min(100, Number.parseInt(req.body.progress_pct, 10) || 0)),
     Number.parseInt(req.body.sequence, 10) || 0, num(req.body.area_sqft),
     String(req.body.notes || '').trim() || null, req.user.id]
  );
  res.status(201).json({ location: rows[0] });
});

export const bulkCreateLocations = asyncHandler(async (req, res) => {
  const projectId = asId(req.params.id);
  const siteId = requireSite(req, res); if (!siteId) return;
  const project = await getScopedProject(projectId, siteId);
  if (!project) return res.status(404).json({ message: 'Project not found' });
  const requestedLocations = Array.isArray(req.body.locations) ? req.body.locations : [];
  if (requestedLocations.length > 500) return res.status(400).json({ message: 'A batch can contain at most 500 locations' });
  const input = requestedLocations;
  if (!input.length) return res.status(400).json({ message: 'locations array is required' });

  const parentId = asId(req.body.parent_id);
  if (parentId && !(await locationBelongsToProject(parentId, projectId))) {
    return res.status(400).json({ message: 'Parent location does not belong to this project' });
  }
  const clean = input.map((row, index) => ({
    name: String(row.name || '').trim(),
    code: String(row.code || '').trim() || null,
    type: normalizeLocationType(row.location_type),
    sequence: Number.parseInt(row.sequence, 10) || index,
    area: num(row.area_sqft),
  }));
  if (clean.some((row) => !row.name || !row.type)) {
    return res.status(400).json({ message: 'Every location needs a name and valid location type' });
  }

  const values = [];
  const placeholders = clean.map((row, index) => {
    const base = index * 8;
    values.push(projectId, parentId, row.type, row.name, row.code, row.sequence, row.area, req.user.id);
    return `($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},$${base + 7},$${base + 8})`;
  });
  const { rows } = await pool.query(
    `INSERT INTO construction_locations
       (project_id, parent_id, location_type, name, code, sequence, area_sqft, created_by)
     VALUES ${placeholders.join(',')} RETURNING *`,
    values
  );
  res.status(201).json({ locations: rows });
});

export const updateLocation = asyncHandler(async (req, res) => {
  const locationId = asId(req.params.locationId);
  const siteId = requireSite(req, res); if (!siteId) return;
  const { rows: existingRows } = await pool.query(
    `SELECT l.* FROM construction_locations l JOIN construction_projects p ON p.id = l.project_id
      WHERE l.id = $1 AND p.site_id = $2`,
    [locationId, siteId]
  );
  const existing = existingRows[0];
  if (!existing) return res.status(404).json({ message: 'Location not found' });

  const allowed = ['name', 'code', 'location_type', 'status', 'progress_pct', 'sequence', 'area_sqft', 'notes', 'parent_id'];
  const sets = [];
  const values = [];
  for (const field of allowed) {
    if (req.body[field] === undefined) continue;
    let value = req.body[field];
    if (field === 'location_type') {
      value = normalizeLocationType(value);
      if (!value) return res.status(400).json({ message: 'Invalid location type' });
    } else if (field === 'status') {
      value = String(value).toUpperCase();
      if (!LOCATION_STATUSES.has(value)) return res.status(400).json({ message: 'Invalid location status' });
    } else if (field === 'progress_pct') value = Math.max(0, Math.min(100, Number.parseInt(value, 10) || 0));
    else if (field === 'sequence') value = Number.parseInt(value, 10) || 0;
    else if (field === 'area_sqft') value = num(value);
    else if (field === 'parent_id') {
      value = asId(value);
      if (value === locationId) return res.status(400).json({ message: 'A location cannot be its own parent' });
      if (value && !(await locationBelongsToProject(value, existing.project_id))) {
        return res.status(400).json({ message: 'Parent location does not belong to this project' });
      }
      if (value) {
        const cycle = await pool.query(
          `WITH RECURSIVE descendants AS (
             SELECT id FROM construction_locations WHERE parent_id = $1
             UNION ALL SELECT l.id FROM construction_locations l JOIN descendants d ON l.parent_id = d.id
           ) SELECT 1 FROM descendants WHERE id = $2 LIMIT 1`,
          [locationId, value]
        );
        if (cycle.rows[0]) return res.status(400).json({ message: 'That parent would create a location cycle' });
      }
    } else value = value === null ? null : String(value).trim() || null;
    values.push(value);
    sets.push(`${field} = $${values.length}`);
  }
  if (!sets.length) return res.status(400).json({ message: 'Nothing to update' });
  values.push(locationId, siteId);
  const { rows } = await pool.query(
    `UPDATE construction_locations l SET ${sets.join(', ')}, updated_at = NOW()
      FROM construction_projects p
     WHERE l.id = $${values.length - 1} AND l.project_id = p.id AND p.site_id = $${values.length}
     RETURNING l.*`,
    values
  );
  res.json({ location: rows[0] });
});

export const deleteLocation = asyncHandler(async (req, res) => {
  const locationId = asId(req.params.locationId);
  const siteId = requireSite(req, res); if (!siteId) return;
  try {
    const { rows } = await pool.query(
      `DELETE FROM construction_locations l USING construction_projects p
        WHERE l.id = $1 AND l.project_id = p.id AND p.site_id = $2 RETURNING l.id`,
      [locationId, siteId]
    );
    if (!rows[0]) return res.status(404).json({ message: 'Location not found' });
    res.json({ success: true });
  } catch (error) {
    if (error.code === '23503') {
      return res.status(409).json({ message: 'Move linked tasks, materials and vendor work before deleting this location' });
    }
    throw error;
  }
});

// ── Tasks ───────────────────────────────────────────────────

export const createTask = asyncHandler(async (req, res) => {
  const projectId = parseInt(req.params.id, 10);
  const siteId = requireSite(req, res); if (!siteId) return;
  const project = await getScopedProject(projectId, siteId);
  if (!project) return res.status(404).json({ message: 'Project not found' });
  const { name, status, progress_pct, sequence, start_date, due_date } = req.body;
  const locationId = asId(req.body.location_id);
  if (!name || !name.trim()) return res.status(400).json({ message: 'Task name is required' });
  const taskStatus = String(status || 'PENDING').toUpperCase();
  if (!TASK_STATUSES.has(taskStatus)) return res.status(400).json({ message: 'Invalid task status' });
  if (locationId && !(await locationBelongsToProject(locationId, projectId))) {
    return res.status(400).json({ message: 'Location does not belong to this project' });
  }
  const { rows } = await pool.query(
    `INSERT INTO construction_tasks (project_id, location_id, name, status, progress_pct, sequence, start_date, due_date, created_by)
     VALUES ($1,$2,$3,COALESCE($4,'PENDING'),$5,$6,$7,$8,$9) RETURNING *`,
    [projectId, locationId, name.trim(), taskStatus,
     Math.max(0, Math.min(100, parseInt(progress_pct, 10) || 0)), parseInt(sequence, 10) || 0,
     start_date || null, due_date || null, req.user.id]
  );
  res.status(201).json({ task: rows[0] });
});

export const updateTask = asyncHandler(async (req, res) => {
  const id = parseInt(req.params.taskId, 10);
  const siteId = requireSite(req, res); if (!siteId) return;
  const { rows: taskRows } = await pool.query(
    `SELECT t.project_id FROM construction_tasks t JOIN construction_projects p ON p.id = t.project_id
      WHERE t.id = $1 AND p.site_id = $2`,
    [id, siteId]
  );
  const task = taskRows[0];
  if (!task) return res.status(404).json({ message: 'Task not found' });
  const fields = ['name', 'status', 'progress_pct', 'sequence', 'start_date', 'due_date', 'location_id'];
  const sets = [];
  const params = [];
  for (const f of fields) {
    if (req.body[f] === undefined) continue;
    let v = req.body[f];
    if (f === 'status') {
      v = String(v).toUpperCase();
      if (!TASK_STATUSES.has(v)) return res.status(400).json({ message: 'Invalid task status' });
    }
    else if (f === 'progress_pct') v = Math.max(0, Math.min(100, parseInt(v, 10) || 0));
    else if (f === 'sequence') v = parseInt(v, 10) || 0;
    else if (f === 'name') v = String(v).trim();
    else if (f === 'location_id') {
      v = asId(v);
      if (v && !(await locationBelongsToProject(v, task.project_id))) {
        return res.status(400).json({ message: 'Location does not belong to this project' });
      }
    }
    else v = v || null;
    params.push(v);
    sets.push(`${f} = $${params.length}`);
  }
  if (sets.length === 0) return res.status(400).json({ message: 'Nothing to update' });
  params.push(id, siteId);
  const { rows } = await pool.query(
    `UPDATE construction_tasks t SET ${sets.join(', ')}, updated_at = NOW()
      FROM construction_projects p
     WHERE t.id = $${params.length - 1} AND t.project_id = p.id AND p.site_id = $${params.length}
     RETURNING t.*`,
    params
  );
  if (!rows[0]) return res.status(404).json({ message: 'Task not found' });
  res.json({ task: rows[0] });
});

export const deleteTask = asyncHandler(async (req, res) => {
  const id = parseInt(req.params.taskId, 10);
  const siteId = requireSite(req, res); if (!siteId) return;
  const del = await pool.query(
    `DELETE FROM construction_tasks t USING construction_projects p
      WHERE t.id = $1 AND t.project_id = p.id AND p.site_id = $2 RETURNING t.id`,
    [id, siteId]
  );
  if (!del.rows[0]) return res.status(404).json({ message: 'Task not found' });
  res.json({ success: true });
});

// ── Material requests ───────────────────────────────────────

export const createMaterialRequest = asyncHandler(async (req, res) => {
  const projectId = parseInt(req.params.id, 10);
  const requestedSiteId = requireSite(req, res); if (!requestedSiteId) return;
  const { task_id, note, items } = req.body;
  const locationId = asId(req.body.location_id);
  if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ message: 'At least one item is required' });
  const clean = items
    .map((i) => ({ material_id: parseInt(i.material_id, 10), qty: Number(i.qty ?? i.qty_requested) }))
    .filter((i) => i.material_id && Number.isFinite(i.qty) && i.qty > 0);
  if (clean.length === 0) return res.status(400).json({ message: 'Items must have a material and a positive qty' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const proj = await client.query('SELECT site_id FROM construction_projects WHERE id = $1 AND site_id = $2', [projectId, requestedSiteId]);
    if (!proj.rows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ message: 'Project not found' }); }
    const siteId = proj.rows[0].site_id;

    if (locationId && !(await locationBelongsToProject(locationId, projectId, client))) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'Location does not belong to this project' });
    }
    if (task_id) {
      const task = await client.query('SELECT 1 FROM construction_tasks WHERE id = $1 AND project_id = $2', [task_id, projectId]);
      if (!task.rows[0]) { await client.query('ROLLBACK'); return res.status(400).json({ message: 'Task does not belong to this project' }); }
    }
    const materialIds = [...new Set(clean.map((item) => item.material_id))];
    const materialCheck = await client.query(
      'SELECT id FROM inventory_materials WHERE site_id = $1 AND id = ANY($2::int[])',
      [siteId, materialIds]
    );
    if (materialCheck.rows.length !== materialIds.length) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'One or more materials do not belong to this site' });
    }

    const reqRow = await client.query(
      `INSERT INTO construction_material_requests (site_id, project_id, task_id, location_id, status, note, requested_by)
       VALUES ($1,$2,$3,$4,'REQUESTED',$5,$6) RETURNING *`,
      [siteId, projectId, task_id || null, locationId, note?.trim() || null, req.user.id]
    );
    const request = reqRow.rows[0];
    const itemValues = [];
    const itemPlaceholders = clean.map((item, index) => {
      const base = index * 3;
      itemValues.push(request.id, item.material_id, item.qty);
      return `($${base + 1},$${base + 2},$${base + 3})`;
    });
    await client.query(
      `INSERT INTO construction_material_request_items (request_id, material_id, qty_requested)
       VALUES ${itemPlaceholders.join(',')}`,
      itemValues
    );
    await client.query('COMMIT');
    res.status(201).json({ request });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

export const getMaterialRequest = asyncHandler(async (req, res) => {
  const id = parseInt(req.params.reqId, 10);
  const siteId = requireSite(req, res); if (!siteId) return;
  const { rows } = await pool.query(
    `SELECT r.*, u.name AS requested_by_name, p.name AS project_name
       FROM construction_material_requests r
       LEFT JOIN users u ON u.id = r.requested_by
       LEFT JOIN construction_projects p ON p.id = r.project_id
      WHERE r.id = $1 AND r.site_id = $2`,
    [id, siteId]
  );
  const request = rows[0];
  if (!request) return res.status(404).json({ message: 'Request not found' });

  const items = await pool.query(
    `WITH balances AS (
       SELECT material_id,
              COALESCE(SUM(CASE
                WHEN movement_type IN ('RECEIPT','RETURN','TRANSFER_IN') THEN qty
                WHEN movement_type IN ('ISSUE','CONSUMPTION','TRANSFER_OUT') THEN -qty
                WHEN movement_type = 'ADJUSTMENT' THEN qty ELSE 0 END), 0) AS on_hand,
              COALESCE(SUM(CASE
                WHEN movement_type = 'RESERVE' THEN qty
                WHEN movement_type = 'UNRESERVE' THEN -qty ELSE 0 END), 0) AS reserved
         FROM inventory_movements WHERE site_id = $2 GROUP BY material_id
     )
     SELECT ri.*, m.name AS material_name, m.unit,
            GREATEST(ri.qty_requested - ri.qty_issued, 0) AS qty_shortage,
            COALESCE(b.on_hand, 0) AS on_hand,
            COALESCE(b.on_hand, 0) - COALESCE(b.reserved, 0) AS available
       FROM construction_material_request_items ri
       JOIN inventory_materials m ON m.id = ri.material_id
       LEFT JOIN balances b ON b.material_id = ri.material_id
      WHERE ri.request_id = $1 ORDER BY ri.id`,
    [id, siteId]
  );
  res.json({ request, items: items.rows });
});

/**
 * Issue available stock against a request. For each line, issue the lesser of
 * (still-needed, currently-available). Physically reduces stock via ISSUE
 * movements, all in one transaction, then recomputes the request status.
 */
export const issueMaterialRequest = asyncHandler(async (req, res) => {
  const id = parseInt(req.params.reqId, 10);
  const siteId = requireSite(req, res); if (!siteId) return;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query('SELECT * FROM construction_material_requests WHERE id = $1 AND site_id = $2 FOR UPDATE', [id, siteId]);
    const request = r.rows[0];
    if (!request) { await client.query('ROLLBACK'); return res.status(404).json({ message: 'Request not found' }); }
    if (request.status === 'CANCELLED') { await client.query('ROLLBACK'); return res.status(400).json({ message: 'Request is cancelled' }); }

    // Take material locks in a stable order so simultaneous multi-item issues
    // cannot deadlock by locking the same materials in opposite orders.
    const itemsRes = await client.query(
      'SELECT * FROM construction_material_request_items WHERE request_id = $1 ORDER BY material_id, id',
      [id]
    );
    const issued = [];
    for (const it of itemsRes.rows) {
      const remaining = Number(it.qty_requested) - Number(it.qty_issued);
      if (remaining <= 0) continue;
      await client.query('SELECT pg_advisory_xact_lock($1, $2)', [141001, it.material_id]);
      const stock = await inventoryModel.stockFor(it.material_id, client); // sees this txn's inserts
      const toIssue = Math.min(remaining, Math.max(0, stock.available));
      if (toIssue <= 0) continue;
      const mat = await client.query('SELECT rate FROM inventory_materials WHERE id = $1', [it.material_id]);
      await inventoryModel.insertMovement({
        site_id: request.site_id, material_id: it.material_id, movement_type: 'ISSUE',
        qty: toIssue, rate: parseFloat(mat.rows[0]?.rate) || 0,
        project_id: request.project_id, task_id: request.task_id, request_id: request.id,
        location_id: request.location_id,
        ref_type: 'material_request', ref_id: request.id, note: 'Issued against material request',
        created_by: req.user.id,
      }, client);
      await client.query('UPDATE construction_material_request_items SET qty_issued = qty_issued + $1 WHERE id = $2', [toIssue, it.id]);
      issued.push({ material_id: it.material_id, qty: toIssue });
    }

    const fresh = await client.query('SELECT qty_requested, qty_issued FROM construction_material_request_items WHERE request_id = $1', [id]);
    const status = deriveRequestStatus(fresh.rows);
    await client.query('UPDATE construction_material_requests SET status = $1, updated_at = NOW() WHERE id = $2', [status, id]);

    await client.query('COMMIT');
    const shortages = fresh.rows
      .map((i) => Number(i.qty_requested) - Number(i.qty_issued))
      .filter((s) => s > 0);
    res.json({ status, issued, has_shortage: shortages.length > 0 });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

export const updateMaterialRequest = asyncHandler(async (req, res) => {
  const id = parseInt(req.params.reqId, 10);
  const siteId = requireSite(req, res); if (!siteId) return;
  const { status, note } = req.body;
  const sets = [];
  const params = [];
  if (status !== undefined) {
    const nextStatus = String(status).toUpperCase();
    if (!REQUEST_STATUSES.has(nextStatus)) return res.status(400).json({ message: 'Invalid material request status' });
    params.push(nextStatus); sets.push(`status = $${params.length}`);
  }
  if (note !== undefined) { params.push(note?.trim() || null); sets.push(`note = $${params.length}`); }
  if (sets.length === 0) return res.status(400).json({ message: 'Nothing to update' });
  params.push(id, siteId);
  const { rows } = await pool.query(
    `UPDATE construction_material_requests SET ${sets.join(', ')}, updated_at = NOW()
      WHERE id = $${params.length - 1} AND site_id = $${params.length} RETURNING *`,
    params
  );
  if (!rows[0]) return res.status(404).json({ message: 'Request not found' });
  res.json({ request: rows[0] });
});

// ── Consumption (draws stock, feeds actual cost) ────────────

export const consumeMaterial = asyncHandler(async (req, res) => {
  const projectId = parseInt(req.params.id, 10);
  const requestedSiteId = requireSite(req, res); if (!requestedSiteId) return;
  const { material_id, qty, task_id, note, rate } = req.body;
  const locationId = asId(req.body.location_id);
  const q = Number(qty);
  if (!material_id || !Number.isFinite(q) || q <= 0) return res.status(400).json({ message: 'material_id and a positive qty are required' });

  const proj = await pool.query('SELECT site_id FROM construction_projects WHERE id = $1 AND site_id = $2', [projectId, requestedSiteId]);
  if (!proj.rows[0]) return res.status(404).json({ message: 'Project not found' });
  const siteId = proj.rows[0].site_id;

  if (locationId && !(await locationBelongsToProject(locationId, projectId))) {
    return res.status(400).json({ message: 'Location does not belong to this project' });
  }
  if (task_id) {
    const task = await pool.query('SELECT 1 FROM construction_tasks WHERE id = $1 AND project_id = $2', [task_id, projectId]);
    if (!task.rows[0]) return res.status(400).json({ message: 'Task does not belong to this project' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1, $2)', [141001, Number(material_id)]);
    const mat = await client.query('SELECT rate FROM inventory_materials WHERE id = $1 AND site_id = $2', [material_id, siteId]);
    if (!mat.rows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ message: 'Material not found for this site' }); }
    const stock = await inventoryModel.stockFor(material_id, client);
    if (q > stock.on_hand) { await client.query('ROLLBACK'); return res.status(400).json({ message: `Only ${stock.on_hand} in stock — cannot consume ${q}` }); }

    const movement = await inventoryModel.insertMovement({
      site_id: siteId, material_id, movement_type: 'CONSUMPTION', qty: q,
      rate: rate !== undefined ? Number(rate) : parseFloat(mat.rows[0].rate) || 0,
      project_id: projectId, task_id: task_id || null, location_id: locationId,
      ref_type: 'consumption', note: note?.trim() || null, created_by: req.user.id,
    }, client);
    await client.query('COMMIT');
    res.status(201).json({ movement });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
});

// ── Dashboard summary ───────────────────────────────────────

export const constructionSummary = asyncHandler(async (req, res) => {
  const siteId = requireSite(req, res); if (!siteId) return;
  const { rows } = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE status = 'ACTIVE')::int AS active_projects,
       COUNT(*) FILTER (WHERE status = 'DELAYED' OR (target_end_date IS NOT NULL AND target_end_date < CURRENT_DATE AND status <> 'COMPLETED'))::int AS delayed_projects,
       COALESCE(ROUND(AVG(progress_pct) FILTER (WHERE status IN ('ACTIVE','DELAYED'))), 0)::int AS avg_progress,
       COALESCE(SUM(budget), 0) AS total_budget
     FROM construction_projects WHERE site_id = $1`,
    [siteId]
  );
  const [pendingReq, actual, structure, types, vendors] = await Promise.all([
    pool.query(`SELECT COUNT(*)::int AS pending_material_requests FROM construction_material_requests WHERE site_id = $1 AND status IN ('REQUESTED','PARTIALLY_FULFILLED')`, [siteId]),
    pool.query(`SELECT COALESCE(SUM(qty*rate),0) AS actual_cost FROM inventory_movements WHERE movement_type='CONSUMPTION' AND site_id = $1`, [siteId]),
    pool.query(
      `SELECT COUNT(*)::int AS total_locations,
              COUNT(*) FILTER (WHERE l.status = 'ACTIVE')::int AS active_locations,
              COUNT(*) FILTER (WHERE l.status = 'COMPLETED')::int AS completed_locations
         FROM construction_locations l JOIN construction_projects p ON p.id = l.project_id
        WHERE p.site_id = $1`,
      [siteId]
    ),
    pool.query(
      `SELECT project_type, COUNT(*)::int AS count
         FROM construction_projects WHERE site_id = $1 GROUP BY project_type ORDER BY count DESC`,
      [siteId]
    ),
    pool.query(
      `SELECT COUNT(*) FILTER (WHERE status = 'open')::int AS active_vendor_commitments,
              COALESCE(SUM(contract_amount) FILTER (WHERE status <> 'cancelled'), 0)::numeric(15,2) AS committed_value
         FROM vendor_commitments WHERE site_id = $1 AND project_id IS NOT NULL`,
      [siteId]
    ),
  ]);
  res.json({
    summary: {
      ...rows[0],
      pending_material_requests: pendingReq.rows[0].pending_material_requests,
      total_actual_cost: parseFloat(actual.rows[0].actual_cost) || 0,
      ...structure.rows[0],
      ...vendors.rows[0],
      project_type_counts: types.rows,
    },
  });
});
