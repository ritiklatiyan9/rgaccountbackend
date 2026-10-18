import asyncHandler from '../utils/asyncHandler.js';
import pool from '../config/db.js';
import { inventoryModel } from '../models/Inventory.model.js';
import {
  constructionError, isConstructionAdmin, positiveId, PROJECT_TRANSITIONS, validateProjectTransition,
  decimalAmount, dateValue, validateDateRange, progressValue,
  assertConstructionSiteAccess, assertConstructionProjectAccess, constructionCanViewAll, constructionPaymentVisibility, projectAccessPredicate,
  validateConstructionAssignment, recordConstructionActivity, markProjectCommitted, projectMetricsSql, buildProjectMetricsSql,
} from '../services/constructionWorkflow.service.js';

const transaction = async fn => {
  const client = await pool.connect();
  try { await client.query('BEGIN'); const result = await fn(client); await client.query('COMMIT'); return result; }
  catch(error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
};
const editableProject = project => {
  if (['CLOSED','CANCELLED'].includes(project.status)) throw constructionError(409, 'Closed or cancelled projects cannot be changed');
};
const projectResponse = row => ({...row, progress_pct: row.calculated_progress_pct ?? row.progress_pct});
const textValue = value => value == null ? null : String(value).trim() || null;
const mutateProjectRecord = (req,projectId,sql,values,action,entityType,details={},validate=null) => transaction(async db=> {
  const project=await assertConstructionProjectAccess(db,req.user,projectId,req.constructionSiteId||positiveId(req.query.site_id||req.body.site_id),{lock:true});editableProject(project);
  if(validate)await validate(db);
  const result=await db.query(sql,values);
  if(result.rows.length)await recordConstructionActivity(db,{projectId,actorId:req.user.id,action,entityType,entityId:result.rows.length===1?result.rows[0].id:null,details});
  return result;
});


// Resolve child IDs from their authoritative project before any read or write.
export const requireConstructionAccess = asyncHandler(async(req,res,next) => {
  const siteId=positiveId(req.query.site_id || req.body?.site_id);
  await assertConstructionSiteAccess(pool,req.user,siteId);
  req.constructionSiteId=siteId;
  req.constructionViewAll=await constructionCanViewAll(pool,req.user);
  let projectId=positiveId(req.params.id);
  if(req.params.id!==undefined&&!projectId)throw constructionError(400,'Invalid project id');
  const child = req.params.taskId ? ['construction_tasks',req.params.taskId] : req.params.locationId ? ['construction_locations',req.params.locationId] : req.params.reqId ? ['construction_material_requests',req.params.reqId] : req.params.quoteId ? ['construction_project_quotes',req.params.quoteId] : null;
  if(child) {
    if(!positiveId(child[1]))throw constructionError(400,'Invalid record id');
    const {rows}=await pool.query(`SELECT project_id FROM ${child[0]} WHERE id=$1`,[positiveId(child[1])]);
    if(!rows[0]) throw constructionError(404,'Record not found');
    projectId=rows[0].project_id;
  }
  if(projectId) {
    req.constructionProject=await assertConstructionProjectAccess(pool,req.user,projectId,siteId);
    if(!['GET','HEAD'].includes(req.method)) editableProject(req.constructionProject);
  }
  next();
});


const optionalArea = value => value == null || value === '' ? null : decimalAmount(value,'Area',{allowZero:true});
const asId = positiveId;
const requireSite = (req, res) => {
  const siteId = parseInt(req.query.site_id || req.body.site_id, 10);
  if (!siteId) { res.status(400).json({ message: 'site_id is required' }); return null; }
  return siteId;
};

const PROJECT_TYPES = new Set([
  'GENERAL', 'STUDIO_APARTMENTS', 'APARTMENTS', 'FLATS', 'PLOTTED_DEVELOPMENT',
  'MIXED_USE', 'INFRASTRUCTURE', 'RENOVATION',
]);
const TASK_STATUSES = new Set(['PENDING', 'IN_PROGRESS', 'BLOCKED', 'DONE']);
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
  const params = [siteId,req.user.id,req.constructionViewAll ?? await constructionCanViewAll(pool,req.user)];
  let where = `WHERE p.site_id=$1 AND ${projectAccessPredicate('p','$2','$3',{legacySafe:true})}`;
  if(req.query.status && req.query.status!=='all') {params.push(req.query.status.toUpperCase());where+=` AND p.status=$${params.length}`;}
  if(req.query.project_type && req.query.project_type!=='all') {params.push(req.query.project_type.toUpperCase());where+=` AND COALESCE(to_jsonb(p)->>'project_type','GENERAL')=$${params.length}`;}
  if(req.query.search?.trim()) {params.push(`%${req.query.search.trim()}%`);where+=` AND (p.name ILIKE $${params.length} OR p.code ILIKE $${params.length})`;}
  const capabilities=(await pool.query("SELECT to_regclass('public.construction_locations') IS NOT NULL AS locations")).rows[0];
  const metrics=buildProjectMetricsSql({legacySafe:true,locationsAvailable:capabilities.locations});
  const {rows}=await pool.query(`${metrics} ${where} ORDER BY p.created_at DESC`,params);
  res.json({projects:rows.map(projectResponse)});
});

export const assignableUsers = asyncHandler(async(req,res)=> {
 const siteId=requireSite(req,res);if(!siteId)return;
 const {rows}=await pool.query(`SELECT u.id,u.name,u.role,
   (u.role IN ('admin','super_admin') OR COALESCE(up.can_update,false)) AS can_approve
   FROM users u JOIN sites picker_site ON picker_site.id=$1 AND picker_site.organization_id=u.organization_id LEFT JOIN user_permissions up ON up.user_id=u.id AND up.module='construction'
   WHERE u.is_active=true AND (u.role IN ('admin','super_admin') OR (u.role='sub_admin'
   AND EXISTS(SELECT 1 FROM user_sites us WHERE us.user_id=u.id AND us.site_id=$1))) ORDER BY u.name,u.id`,[siteId]);
 res.json({users:rows});
});

export const createProject = asyncHandler(async (req, res) => {
  const siteId = requireSite(req, res); if (!siteId) return;
  const name=textValue(req.body.name);if(!name) throw constructionError(400,'Project name is required');
  const projectType=normalizeProjectType(req.body.project_type);
  const status=String(req.body.status || 'NEED').toUpperCase();
  if(!projectType) throw constructionError(400,'Invalid project type');
  if(!['NEED','PLANNING'].includes(status)) throw constructionError(400,'A project must start as a need');
  const priority=String(req.body.priority||'NORMAL').toUpperCase();
  if(!['LOW','NORMAL','HIGH','URGENT'].includes(priority)) throw constructionError(400,'Invalid priority');
  const start=dateValue(req.body.start_date),end=dateValue(req.body.target_end_date);validateDateRange(start,end);
  const project=await transaction(async db=> {
    await assertConstructionSiteAccess(db,req.user,siteId);
    if(!isConstructionAdmin(req.user) && ['owner_user_id','assigned_admin_id','assigned_approver_id'].some(k=>req.body[k] && Number(req.body[k])!==req.user.id)) throw constructionError(403,'Only administrators can assign project users');
    const owner=await validateConstructionAssignment(db,siteId,req.body.owner_user_id || req.body.assigned_admin_id || req.user.id);
    const approver=await validateConstructionAssignment(db,siteId,req.body.assigned_approver_id,{approver:true,approvalModule:'construction'});
    const {rows}=await db.query(`INSERT INTO construction_projects(site_id,name,code,project_type,status,start_date,target_end_date,budget,notes,scope,priority,owner_user_id,assigned_admin_id,assigned_approver_id,requested_by,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12,$13,$14,$14) RETURNING *`,
      [siteId,name,textValue(req.body.code),projectType,status,start,end,decimalAmount(req.body.budget??'0','Budget',{allowZero:true}),textValue(req.body.notes),textValue(req.body.scope),priority,owner,approver,req.user.id]);
    await recordConstructionActivity(db,{projectId:rows[0].id,actorId:req.user.id,action:'need_created',details:{status,owner_user_id:owner}});
    return rows[0];
  });
  res.status(201).json({project});
});

export const getProject = asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const siteId = requireSite(req, res); if (!siteId) return;
  const { rows } = await pool.query(
    `${projectMetricsSql} WHERE p.id=$1 AND p.site_id=$2`,
    [id, siteId]
  );
  const project = rows[0];
  if (!project) return res.status(404).json({ message: 'Project not found' });

  const paymentVisibility=await constructionPaymentVisibility(pool,req.user);
  const [tasks, requests, cost, locations, commitments, locationCosts, quotes, activity, payments, movements] = await Promise.all([
    pool.query(`SELECT t.*, l.name AS location_name, l.location_type, owner.name AS owner_name
                  FROM construction_tasks t
                  LEFT JOIN users owner ON owner.id=t.owner_user_id
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
              COALESCE(SUM(posted.paid_amount), 0)::numeric(14,2) AS paid_amount
         FROM vendor_commitments vc
         LEFT JOIN vendor_payments vp ON vp.commitment_id = vc.id
         LEFT JOIN LATERAL (SELECT SUM(le.debit-le.credit) paid_amount FROM ledger_entries le WHERE le.source_key='vendor_payments' AND le.source_id=vp.id AND le.ledger_type='site' AND le.site_id=vc.site_id) posted ON true
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
    pool.query(`SELECT q.*,u.name AS created_by_name FROM construction_project_quotes q LEFT JOIN users u ON u.id=q.created_by WHERE q.project_id=$1 ORDER BY q.id DESC`,[id]),
    pool.query(`SELECT a.*,u.name AS actor_name FROM construction_project_activity a LEFT JOIN users u ON u.id=a.actor_id WHERE a.project_id=$1 AND (a.entity_type<>'vendor_payment' OR ($2::boolean AND ($3::boolean OR EXISTS(SELECT 1 FROM vendor_payments visible_payment WHERE visible_payment.id=a.entity_id AND visible_payment.created_by=$4)))) ORDER BY a.id DESC LIMIT 100`,[id,paymentVisibility.read,paymentVisibility.all,req.user.id]),
    pool.query(`SELECT vp.*,vc.vendor_name,vc.work_title,u.name AS created_by_name,
      COALESCE(posted.paid_amount,0)::numeric(15,2) AS posted_amount,'vendor_payments' AS source_key
      FROM vendor_payments vp JOIN vendor_commitments vc ON vc.id=vp.commitment_id LEFT JOIN users u ON u.id=vp.created_by
      LEFT JOIN LATERAL(SELECT SUM(le.debit-le.credit) paid_amount FROM ledger_entries le WHERE le.source_key='vendor_payments' AND le.source_id=vp.id AND le.ledger_type='site' AND le.site_id=vc.site_id) posted ON true
      WHERE vc.project_id=$1 AND $2::boolean AND ($3::boolean OR vp.created_by=$4) ORDER BY vp.payment_date DESC,vp.id DESC`,[id,paymentVisibility.read,paymentVisibility.all,req.user.id]),
    pool.query(`SELECT mv.*,m.name AS material_name,m.unit,l.name AS location_name,u.name AS created_by_name
      FROM inventory_movements mv JOIN inventory_materials m ON m.id=mv.material_id
      LEFT JOIN users u ON u.id=mv.created_by LEFT JOIN construction_locations l ON l.id=mv.location_id
      WHERE mv.project_id=$1 ORDER BY mv.created_at DESC,mv.id DESC LIMIT 100`,[id]),
  ]);

  const allowed=(PROJECT_TRANSITIONS[project.status]||[]).filter(status=>status!=='APPROVED'||isConstructionAdmin(req.user)||(project.assigned_approver_id===req.user.id&&project.created_by!==req.user.id));
  res.json({
    project: { ...projectResponse(project), actual_cost: cost.rows[0].actual_cost, allowed_statuses: allowed },
    allowed_statuses: allowed,
    quotes: quotes.rows, activity: activity.rows, vendor_payments: payments.rows, material_movements: movements.rows,
    payment_history_restricted:!paymentVisibility.read||!paymentVisibility.all,
    tasks: tasks.rows,
    material_requests: requests.rows,
    locations: locations.rows,
    vendor_commitments: commitments.rows,
    location_costs: locationCosts.rows,
  });
});

export const updateProject = asyncHandler(async (req, res) => {
 const id=positiveId(req.params.id),siteId=requireSite(req,res);if(!siteId)return;
 const project=await transaction(async db=> {
   const current=await assertConstructionProjectAccess(db,req.user,id,siteId,{lock:true});editableProject(current);
   const fields=['name','code','project_type','status','start_date','target_end_date','actual_start_date','actual_end_date','budget','progress_pct','notes','scope','priority','owner_user_id','assigned_admin_id','assigned_approver_id'];
   const change={};
   for(const field of fields) {
     if(req.body[field]===undefined) continue;
     let value=req.body[field];
     if(field==='name') {value=textValue(value);if(!value)throw constructionError(400,'Project name is required');}
     else if(field==='project_type') {value=normalizeProjectType(value);if(!value)throw constructionError(400,'Invalid project type');}
     else if(field==='status') {value=String(value).toUpperCase();validateProjectTransition(current.status,value);}
     else if(field==='priority') {value=String(value).toUpperCase();if(!['LOW','NORMAL','HIGH','URGENT'].includes(value))throw constructionError(400,'Invalid priority');}
     else if(field==='budget') value=decimalAmount(value,'Budget',{allowZero:true});
     else if(field==='progress_pct') value=progressValue(value);
     else if(field.endsWith('_date')) value=dateValue(value);
     else if(['owner_user_id','assigned_admin_id','assigned_approver_id'].includes(field)) {
       if(!isConstructionAdmin(req.user)) throw constructionError(403,'Only administrators can assign project users');
       value=await validateConstructionAssignment(db,siteId,value,{approver:field==='assigned_approver_id',approvalModule:'construction'});
     } else value=textValue(value);
     change[field]=value;
   }
   if(!Object.keys(change).length) throw constructionError(400,'Nothing to update');
   if(!isConstructionAdmin(req.user)&&!['NEED','PLANNING','REVIEW'].includes(current.status)&&['budget','scope'].some(field=>change[field]!==undefined&&String(change[field]??'')!==String(current[field]??'')))throw constructionError(403,'Only administrators can change an approved project budget or scope');
   if(change.owner_user_id!==undefined) change.assigned_admin_id=change.owner_user_id;
   else if(change.assigned_admin_id!==undefined) change.owner_user_id=change.assigned_admin_id;
   validateDateRange(change.start_date===undefined?current.start_date:change.start_date,change.target_end_date===undefined?current.target_end_date:change.target_end_date);
   validateDateRange(change.actual_start_date===undefined?current.actual_start_date:change.actual_start_date,change.actual_end_date===undefined?current.actual_end_date:change.actual_end_date);
   if(change.budget!==undefined) {
     const {rows}=await db.query("SELECT COALESCE(SUM(contract_amount),0)>$2::numeric AS exceeded FROM vendor_commitments WHERE project_id=$1 AND status<>'cancelled'",[id,change.budget]);
     if(rows[0].exceeded) throw constructionError(409,'Budget cannot be less than existing vendor commitments');
   }
   if(change.status==='APPROVED' && current.status!=='APPROVED') {
     if(!isConstructionAdmin(req.user) && (current.assigned_approver_id!==req.user.id || current.created_by===req.user.id)) throw constructionError(403,'Only the assigned approver or an administrator can approve this need');
     change.approved_by=req.user.id;change.approved_at=new Date();
   }
   if(change.status==='COMMITTED' && current.status!=='COMMITTED') {
     if(!(await db.query("SELECT 1 FROM vendor_commitments WHERE project_id=$1 AND status<>'cancelled' LIMIT 1",[id])).rows[0]) throw constructionError(409,'Select a vendor commitment before marking this project committed');
   }
   if(['COMPLETED','CLOSED'].includes(change.status)) {
     if((await db.query("SELECT 1 FROM construction_tasks WHERE project_id=$1 AND status<>'DONE' LIMIT 1",[id])).rows[0]) throw constructionError(409,'Complete all tasks and milestones first');
     change.progress_pct=100;
     if(!current.actual_end_date&&!change.actual_end_date)change.actual_end_date=new Date().toISOString().slice(0,10);
   }
   if(change.status==='CLOSED') {
     if((await db.query("SELECT 1 FROM vendor_payments vp JOIN vendor_commitments vc ON vc.id=vp.commitment_id WHERE vc.project_id=$1 AND vp.status='pending' LIMIT 1",[id])).rows[0]) throw constructionError(409,'Resolve pending vendor payments before closing the project');
   }
   if(change.status==='CANCELLED' && (await db.query("SELECT 1 FROM vendor_commitments WHERE project_id=$1 AND status<>'cancelled' LIMIT 1",[id])).rows[0]) throw constructionError(409,'Resolve vendor commitments before cancelling this project');
   if(change.status==='IN_PROGRESS'&&!current.actual_start_date&&!change.actual_start_date)change.actual_start_date=new Date().toISOString().slice(0,10);
   const keys=Object.keys(change),values=Object.values(change);values.push(id);
   const {rows}=await db.query(`UPDATE construction_projects SET ${keys.map((k,i)=>`${k}=$${i+1}`).join(',')},updated_at=NOW() WHERE id=$${values.length} RETURNING *`,values);
   await recordConstructionActivity(db,{projectId:id,actorId:req.user.id,action:change.status&&change.status!==current.status?'status_changed':'project_updated',details:{from:current.status,to:change.status||current.status,changes:change}});
   return rows[0];
 });
 res.json({project});
});

export const deleteProject = asyncHandler(async (req, res) => {
 // Project history and financial source links are retained. Cancellation is the
 // supported removal action; no historical payment is deleted or reversed.
 throw constructionError(409,'Projects retain their history. Cancel an uncommitted need or close completed work instead.');
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
  const { rows } = await mutateProjectRecord(req,projectId,
    `INSERT INTO construction_locations
       (project_id, parent_id, location_type, name, code, status, progress_pct, sequence, area_sqft, notes, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [projectId, parentId, locationType, name, String(req.body.code || '').trim() || null, status,
     progressValue(req.body.progress_pct??0),
     Number.parseInt(req.body.sequence, 10) || 0, optionalArea(req.body.area_sqft),
     String(req.body.notes || '').trim() || null, req.user.id], 'location_created', 'location', {name,location_type:locationType}
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
    area: optionalArea(row.area_sqft),
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
  const { rows } = await mutateProjectRecord(req,projectId,
    `INSERT INTO construction_locations
       (project_id, parent_id, location_type, name, code, sequence, area_sqft, created_by)
     VALUES ${placeholders.join(',')} RETURNING *`,
    values, 'locations_created', 'location', {count:clean.length}
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
    } else if (field === 'progress_pct') value = progressValue(value);
    else if (field === 'sequence') value = Number.parseInt(value, 10) || 0;
    else if (field === 'area_sqft') value = optionalArea(value);
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
    } else { value = value === null ? null : String(value).trim() || null; if(field==='name'&&!value)throw constructionError(400,'Location name is required'); }
    values.push(value);
    sets.push(`${field} = $${values.length}`);
  }
  if (!sets.length) return res.status(400).json({ message: 'Nothing to update' });
  values.push(locationId, siteId);
  const { rows } = await mutateProjectRecord(req,existing.project_id,
    `UPDATE construction_locations l SET ${sets.join(', ')}, updated_at = NOW()
      FROM construction_projects p
     WHERE l.id = $${values.length - 1} AND l.project_id = p.id AND p.site_id = $${values.length}
     RETURNING l.*`,
    values, 'location_updated', 'location', {changes:req.body}, async db=> {
      if(req.body.parent_id) {
        const cycle=await db.query(`WITH RECURSIVE descendants AS (
          SELECT id FROM construction_locations WHERE parent_id=$1
          UNION ALL SELECT l.id FROM construction_locations l JOIN descendants d ON l.parent_id=d.id
        ) SELECT 1 FROM descendants WHERE id=$2 LIMIT 1`,[locationId,asId(req.body.parent_id)]);
        if(cycle.rows[0])throw constructionError(400,'That parent would create a location cycle');
      }
    }
  );
  res.json({ location: rows[0] });
});

export const deleteLocation = asyncHandler(async (req, res) => {
  const locationId = asId(req.params.locationId);
  const siteId = requireSite(req, res); if (!siteId) return;
  try {
    const { rows } = await mutateProjectRecord(req,req.constructionProject?.id || (await pool.query('SELECT project_id FROM construction_locations WHERE id=$1',[locationId])).rows[0]?.project_id,
      `DELETE FROM construction_locations l USING construction_projects p
        WHERE l.id = $1 AND l.project_id = p.id AND p.site_id = $2 RETURNING l.id`,
      [locationId, siteId], 'location_deleted', 'location', {}
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

export const createTask = asyncHandler(async(req,res)=> {
 const projectId=positiveId(req.params.id),siteId=requireSite(req,res);if(!siteId)return;
 const task=await transaction(async db=> {
   const project=await assertConstructionProjectAccess(db,req.user,projectId,siteId,{lock:true});editableProject(project);
   const name=textValue(req.body.name);if(!name)throw constructionError(400,'Task name is required');
   const status=String(req.body.status||'PENDING').toUpperCase();if(!TASK_STATUSES.has(status))throw constructionError(400,'Invalid task status');
   const requestedProgress=progressValue(req.body.progress_pct??0);
   const progress=status==='DONE'?100:requestedProgress;
   if(progress===100&&status!=='DONE')throw constructionError(400,'Set the task status to DONE for 100% progress');
   const locationId=positiveId(req.body.location_id);
   if(locationId&&!await locationBelongsToProject(locationId,projectId,db))throw constructionError(400,'Location does not belong to this project');
   if(!isConstructionAdmin(req.user)&&req.body.owner_user_id&&Number(req.body.owner_user_id)!==req.user.id)throw constructionError(403,'Only administrators can assign task owners');
   const owner=await validateConstructionAssignment(db,siteId,req.body.owner_user_id||req.user.id);
   const start=dateValue(req.body.start_date),due=dateValue(req.body.due_date);validateDateRange(start,due);
   const {rows}=await db.query(`INSERT INTO construction_tasks(project_id,location_id,name,status,progress_pct,sequence,start_date,due_date,created_by,owner_user_id,notes,is_milestone)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,[projectId,locationId,name,status,progress,Number.parseInt(req.body.sequence,10)||0,start,due,req.user.id,owner,textValue(req.body.notes),req.body.is_milestone===true]);
   await recordConstructionActivity(db,{projectId,actorId:req.user.id,action:'task_created',entityType:'task',entityId:rows[0].id,details:{name,owner_user_id:owner,status}});
   return rows[0];
 });res.status(201).json({task});
});

export const updateTask = asyncHandler(async(req,res)=> {
 const id=positiveId(req.params.taskId),siteId=requireSite(req,res);if(!siteId)return;
 const task=await transaction(async db=> {
   const {rows:existing}=await db.query(`SELECT t.* FROM construction_tasks t JOIN construction_projects p ON p.id=t.project_id WHERE t.id=$1 AND p.site_id=$2 FOR UPDATE OF t`,[id,siteId]);
   const current=existing[0];if(!current)throw constructionError(404,'Task not found');
   const project=await assertConstructionProjectAccess(db,req.user,current.project_id,siteId,{lock:true});editableProject(project);
   const change={};
   for(const field of ['name','status','progress_pct','sequence','start_date','due_date','location_id','owner_user_id','notes','is_milestone']) {
     if(req.body[field]===undefined)continue;
     let value=req.body[field];
     if(field==='name'){value=textValue(value);if(!value)throw constructionError(400,'Task name is required');}
     else if(field==='status'){value=String(value).toUpperCase();if(!TASK_STATUSES.has(value))throw constructionError(400,'Invalid task status');}
     else if(field==='progress_pct')value=progressValue(value);
     else if(field==='sequence'){value=Number(value);if(!Number.isInteger(value))throw constructionError(400,'Sequence must be an integer');}
     else if(field==='is_milestone'){if(typeof value!=='boolean')throw constructionError(400,'Milestone must be true or false');}
     else if(field.endsWith('_date'))value=dateValue(value);
     else if(field==='owner_user_id'){
       if(!isConstructionAdmin(req.user))throw constructionError(403,'Only administrators can assign task owners');
       value=await validateConstructionAssignment(db,siteId,value);
     } else if(field==='location_id'){
       value=positiveId(value);if(value&&!await locationBelongsToProject(value,current.project_id,db))throw constructionError(400,'Location does not belong to this project');
     } else value=textValue(value);
     change[field]=value;
   }
   if(!Object.keys(change).length)throw constructionError(400,'Nothing to update');
   const status=change.status||current.status;
   if(status==='DONE')change.progress_pct=100;
   else if((change.progress_pct??current.progress_pct)===100)throw constructionError(400,'Set progress below 100 when reopening a task');
   validateDateRange(change.start_date===undefined?current.start_date:change.start_date,change.due_date===undefined?current.due_date:change.due_date);
   const keys=Object.keys(change),values=Object.values(change);values.push(id);
   const {rows}=await db.query(`UPDATE construction_tasks SET ${keys.map((k,i)=>`${k}=$${i+1}`).join(',')},updated_at=NOW() WHERE id=$${values.length} RETURNING *`,values);
   await recordConstructionActivity(db,{projectId:current.project_id,actorId:req.user.id,action:'task_updated',entityType:'task',entityId:id,details:{changes:change}});
   return rows[0];
 });res.json({task});
});

export const deleteTask = asyncHandler(async(req,res)=> {
 const id=positiveId(req.params.taskId),siteId=requireSite(req,res);if(!siteId)return;
 await transaction(async db=> {
   const {rows}=await db.query(`SELECT t.* FROM construction_tasks t JOIN construction_projects p ON p.id=t.project_id WHERE t.id=$1 AND p.site_id=$2 FOR UPDATE OF t`,[id,siteId]);
   if(!rows[0])throw constructionError(404,'Task not found');
   const project=await assertConstructionProjectAccess(db,req.user,rows[0].project_id,siteId,{lock:true});editableProject(project);
   if((await db.query('SELECT 1 FROM inventory_movements WHERE task_id=$1 LIMIT 1',[id])).rows[0])throw constructionError(409,'Tasks with material history cannot be deleted');
   await db.query('DELETE FROM construction_tasks WHERE id=$1',[id]);
   await recordConstructionActivity(db,{projectId:project.id,actorId:req.user.id,action:'task_deleted',entityType:'task',entityId:id,details:{name:rows[0].name}});
 });res.json({success:true});
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
  if (clean.length !== items.length || clean.length === 0) return res.status(400).json({ message: 'Every item must have a material and a positive qty' });
  if(new Set(clean.map(item=>item.material_id)).size!==clean.length) throw constructionError(400,'Each material can appear only once in a request');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const project=await assertConstructionProjectAccess(client,req.user,projectId,requestedSiteId,{lock:true});editableProject(project);
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
    await recordConstructionActivity(client,{projectId,actorId:req.user.id,action:'material_requested',entityType:'material_request',entityId:request.id,details:{item_count:clean.length}});
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
    if (request.status === 'CANCELLED' || request.status === 'DRAFT') { await client.query('ROLLBACK'); return res.status(409).json({ message: 'Submit the material request before issuing stock' }); }
    const project=await assertConstructionProjectAccess(client,req.user,request.project_id,siteId,{lock:true});editableProject(project);
    if(['NEED','PLANNING','REVIEW','COMPLETED'].includes(project.status))throw constructionError(409,'Materials can be issued only for approved work');

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

    await recordConstructionActivity(client,{projectId:request.project_id,actorId:req.user.id,action:'materials_issued',entityType:'material_request',entityId:request.id,details:{issued,status}});
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

export const updateMaterialRequest=asyncHandler(async(req,res)=> {
 const siteId=requireSite(req,res);if(!siteId)return;
 const request=await transaction(async db=> {
   const {rows}=await db.query('SELECT * FROM construction_material_requests WHERE id=$1 AND site_id=$2 FOR UPDATE',[positiveId(req.params.reqId),siteId]);
   const current=rows[0];if(!current)throw constructionError(404,'Request not found');
   const project=await assertConstructionProjectAccess(db,req.user,current.project_id,siteId,{lock:true});editableProject(project);
   const status=String(req.body.status||current.status).toUpperCase();
   const transitions={DRAFT:['DRAFT','REQUESTED','CANCELLED'],REQUESTED:['REQUESTED','CANCELLED'],PARTIALLY_FULFILLED:['PARTIALLY_FULFILLED'],FULFILLED:['FULFILLED'],CANCELLED:['CANCELLED']};
   if(!transitions[current.status]?.includes(status))throw constructionError(409,'Request fulfillment is derived from issued stock; issued requests cannot be cancelled or reset');
   const updated=await db.query('UPDATE construction_material_requests SET status=$1,note=$2,updated_at=NOW() WHERE id=$3 RETURNING *',[status,req.body.note===undefined?current.note:textValue(req.body.note),current.id]);
   await recordConstructionActivity(db,{projectId:project.id,actorId:req.user.id,action:'material_request_updated',entityType:'material_request',entityId:current.id,details:{from:current.status,to:status}});
   return updated.rows[0];
 });res.json({request});
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
    const project=await assertConstructionProjectAccess(client,req.user,projectId,siteId,{lock:true});editableProject(project);
    if(['NEED','PLANNING','REVIEW','COMPLETED'].includes(project.status))throw constructionError(409,'Materials can be consumed only for approved work');
    await client.query('SELECT pg_advisory_xact_lock($1, $2)', [141001, Number(material_id)]);
    const mat = await client.query('SELECT rate FROM inventory_materials WHERE id = $1 AND site_id = $2', [material_id, siteId]);
    if (!mat.rows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ message: 'Material not found for this site' }); }
    const stock = await inventoryModel.stockFor(material_id, client);
    if (q > stock.available) { await client.query('ROLLBACK'); return res.status(400).json({ message: `Only ${stock.available} available in stock — cannot consume ${q}` }); }

    const movement = await inventoryModel.insertMovement({
      site_id: siteId, material_id, movement_type: 'CONSUMPTION', qty: q,
      rate: decimalAmount(rate !== undefined ? rate : mat.rows[0].rate,'Material rate',{allowZero:true}),
      project_id: projectId, task_id: task_id || null, location_id: locationId,
      ref_type: 'consumption', note: note?.trim() || null, created_by: req.user.id,
    }, client);
    await recordConstructionActivity(client,{projectId,actorId:req.user.id,action:'material_consumed',entityType:'inventory_movement',entityId:movement.id,details:{material_id,qty:q}});
    await client.query('COMMIT');
    res.status(201).json({ movement });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
});

// ── Vendor quote review and selection ─────────────────────────────────────
const cleanQuote = async (db,siteId,body,current={}) => {
 const vendorId=body.vendor_member_id===undefined?current.vendor_member_id:positiveId(body.vendor_member_id);
 let vendorName=textValue(body.vendor_name===undefined?current.vendor_name:body.vendor_name);
 if(vendorId) {
   const {rows}=await db.query("SELECT full_name FROM members WHERE id=$1 AND site_id=$2 AND (member_type='VENDOR' OR 'VENDOR'=ANY(COALESCE(member_types,ARRAY[]::text[])))",[vendorId,siteId]);
   if(!rows[0])throw constructionError(400,'Selected vendor is invalid for this site');
   vendorName=rows[0].full_name;
 }
 if(!vendorName)throw constructionError(400,'Vendor name is required');
 const quoteDate=dateValue(body.quote_date===undefined?(current.quote_date||new Date().toISOString().slice(0,10)):body.quote_date);
 if(!quoteDate)throw constructionError(400,'Quote date is required');
 const validUntil=dateValue(body.valid_until===undefined?current.valid_until:body.valid_until);validateDateRange(quoteDate,validUntil);
 return {vendor_member_id:vendorId||null,vendor_name:vendorName,amount:decimalAmount(body.amount===undefined?current.amount:body.amount,'Quote amount'),scope:textValue(body.scope===undefined?current.scope:body.scope),terms:textValue(body.terms===undefined?current.terms:body.terms),quote_date:quoteDate,valid_until:validUntil};
};
export const createQuote=asyncHandler(async(req,res)=> {
 const siteId=requireSite(req,res);if(!siteId)return;
 const projectId=positiveId(req.params.id);
 const quote=await transaction(async db=> {
   const project=await assertConstructionProjectAccess(db,req.user,projectId,siteId,{lock:true});editableProject(project);
   const q=await cleanQuote(db,siteId,req.body);
   const {rows}=await db.query(`INSERT INTO construction_project_quotes(project_id,vendor_member_id,vendor_name,amount,scope,terms,quote_date,valid_until,created_by,updated_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$9) RETURNING *`,[projectId,q.vendor_member_id,q.vendor_name,q.amount,q.scope,q.terms,q.quote_date,q.valid_until,req.user.id]);
   await recordConstructionActivity(db,{projectId,actorId:req.user.id,action:'quote_received',entityType:'quote',entityId:rows[0].id,details:{vendor_name:q.vendor_name,amount:q.amount}});
   return rows[0];
 });res.status(201).json({quote});
});
export const updateQuote=asyncHandler(async(req,res)=> {
 const siteId=requireSite(req,res);if(!siteId)return;
 const quote=await transaction(async db=> {
   const preliminary=await db.query('SELECT project_id FROM construction_project_quotes WHERE id=$1',[positiveId(req.params.quoteId)]);
   if(!preliminary.rows[0])throw constructionError(404,'Quote not found');
   const project=await assertConstructionProjectAccess(db,req.user,preliminary.rows[0].project_id,siteId,{lock:true});editableProject(project);
   const {rows:existing}=await db.query('SELECT * FROM construction_project_quotes WHERE id=$1 FOR UPDATE',[positiveId(req.params.quoteId)]);
   const current=existing[0];
   if(current.status==='SELECTED')throw constructionError(409,'Selected quote is locked to its vendor commitment');
   const status=String(req.body.status||current.status).toUpperCase();if(!['RECEIVED','SHORTLISTED','REJECTED'].includes(status))throw constructionError(400,'Invalid quote status; use Select to hire the vendor');
   const q=await cleanQuote(db,siteId,req.body,current);
   const {rows}=await db.query(`UPDATE construction_project_quotes SET vendor_member_id=$1,vendor_name=$2,amount=$3,scope=$4,terms=$5,quote_date=$6,valid_until=$7,status=$8,updated_by=$9,updated_at=NOW() WHERE id=$10 RETURNING *`,[q.vendor_member_id,q.vendor_name,q.amount,q.scope,q.terms,q.quote_date,q.valid_until,status,req.user.id,current.id]);
   await recordConstructionActivity(db,{projectId:project.id,actorId:req.user.id,action:'quote_updated',entityType:'quote',entityId:current.id,details:{status,amount:q.amount,vendor_name:q.vendor_name}});
   return rows[0];
 });res.json({quote});
});
export const selectQuote=asyncHandler(async(req,res)=> {
 const siteId=requireSite(req,res);if(!siteId)return;
 const result=await transaction(async db=> {
   // Lock the project before the quote to serialize budget checks and retries.
   const preliminary=await db.query('SELECT project_id FROM construction_project_quotes WHERE id=$1',[positiveId(req.params.quoteId)]);
   if(!preliminary.rows[0])throw constructionError(404,'Quote not found');
   const project=await assertConstructionProjectAccess(db,req.user,preliminary.rows[0].project_id,siteId,{lock:true});editableProject(project);
   const {rows}=await db.query('SELECT * FROM construction_project_quotes WHERE id=$1 FOR UPDATE',[positiveId(req.params.quoteId)]);const quote=rows[0];
   if(quote.status==='SELECTED') {
     const existing=await db.query('SELECT * FROM vendor_commitments WHERE id=$1',[quote.commitment_id]);
     return {quote,commitment:existing.rows[0],replayed:true};
   }
   if(!isConstructionAdmin(req.user))throw constructionError(403,'Only administrators can hire and assign vendors');
   if(!['APPROVED','COMMITTED','IN_PROGRESS','ON_HOLD','ACTIVE','DELAYED'].includes(project.status))throw constructionError(409,'Approve the project need before selecting a vendor');
   if(quote.status==='REJECTED')throw constructionError(409,'A rejected quote cannot be selected');
   if(quote.valid_until&&dateValue(quote.valid_until)<new Date().toISOString().slice(0,10))throw constructionError(409,'This quote has expired; obtain an updated quote first');
   const check=await db.query("SELECT COALESCE(SUM(contract_amount),0)+$2::numeric>$3::numeric AS exceeded FROM vendor_commitments WHERE project_id=$1 AND status<>'cancelled'",[project.id,quote.amount,project.budget]);
   if(check.rows[0].exceeded)throw constructionError(409,'Vendor commitment exceeds the remaining project budget');
   const start=dateValue(req.body.start_date??project.start_date),due=dateValue(req.body.due_date??project.target_end_date);validateDateRange(start,due);
   const headId=positiveId(req.body.head_id);let headName=textValue(req.body.head_name)||'Construction';
   if(headId){const head=await db.query('SELECT name FROM vendor_heads WHERE id=$1 AND site_id=$2 AND is_active=true',[headId,siteId]);if(!head.rows[0])throw constructionError(400,'Selected head is invalid for this site');headName=head.rows[0].name;}
   const workTitle=textValue(req.body.work_title)||project.name;if(workTitle.length>220)throw constructionError(400,'Work title must be at most 220 characters');
   const financialApprover=await validateConstructionAssignment(db,siteId,req.body.assigned_admin_id,{approver:true});
   const inserted=await db.query(`INSERT INTO vendor_commitments(site_id,vendor_member_id,vendor_name,head_id,head_name,work_title,contract_amount,start_date,due_date,note,terms,created_by,assigned_admin_id,project_id,selected_quote_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,[siteId,quote.vendor_member_id,quote.vendor_name,headId,headName,workTitle,quote.amount,start,due,quote.scope,textValue(req.body.terms)||quote.terms,req.user.id,financialApprover,project.id,quote.id]);
   const commitment=inserted.rows[0];
   const selected=await db.query("UPDATE construction_project_quotes SET status='SELECTED',commitment_id=$1,updated_by=$2,updated_at=NOW() WHERE id=$3 RETURNING *",[commitment.id,req.user.id,quote.id]);
   await markProjectCommitted(db,req.user,project.id,siteId,commitment.id);
   await recordConstructionActivity(db,{projectId:project.id,actorId:req.user.id,action:'quote_selected',entityType:'quote',entityId:quote.id,details:{commitment_id:commitment.id,vendor_name:quote.vendor_name,amount:quote.amount}});
   return {quote:selected.rows[0],commitment};
 });res.status(result.replayed?200:201).json(result);
});

// ── Dashboard summary ─────────────────────────────────────────────────────
export async function getConstructionSummaryData({siteId,user,projectId=null,viewAll},db=pool) {
 await assertConstructionSiteAccess(db,user,siteId);
 const params=[siteId,user.id,viewAll??await constructionCanViewAll(db,user)];
 let where=`p.site_id=$1 AND ${projectAccessPredicate('p','$2','$3',{legacySafe:true})}`;
 if(projectId){const id=positiveId(projectId);if(!id)throw constructionError(400,'Invalid project filter');params.push(id);where+=` AND p.id=$${params.length}`;}
 // Probe optional tables before constructing SQL, without swallowing actual
 // database failures or weakening project/site authorization. Missing columns
 // in pre-141/219 rows represent absent assignments/links, never new access.
 const capabilities=(await db.query(`SELECT
   to_regclass('public.construction_locations') IS NOT NULL AS locations,
   to_regclass('public.construction_project_activity') IS NOT NULL AS activity`)).rows[0];
 const metrics=`${buildProjectMetricsSql({legacySafe:true,locationsAvailable:capabilities.locations})} WHERE ${where}`;
 const projectType="COALESCE(NULLIF(to_jsonb(p)->>'project_type',''),'GENERAL')";
 const commitmentProjectId="(to_jsonb(vc)->>'project_id')::integer";
 const paymentVisibility=await constructionPaymentVisibility(db,user);
 const paymentParams=[...params,paymentVisibility.read,paymentVisibility.all,user.id];
 const paymentWhere=`${where} AND $${params.length+1}::boolean AND ($${params.length+2}::boolean OR vp.created_by=$${params.length+3})`;
 const activityWhere=`${where} AND (a.entity_type<>'vendor_payment' OR ($${params.length+1}::boolean AND ($${params.length+2}::boolean OR EXISTS(SELECT 1 FROM vendor_payments visible_payment WHERE visible_payment.id=a.entity_id AND visible_payment.created_by=$${params.length+3}))))`;
 const [aggregate,projects,statuses,types,activity,payments]=await Promise.all([
   db.query(`WITH metrics AS (${metrics}) SELECT
    COUNT(*) FILTER(WHERE status IN ('COMMITTED','IN_PROGRESS','ACTIVE','DELAYED'))::int AS active_projects,
    COUNT(*) FILTER(WHERE status='DELAYED' OR is_overdue)::int AS delayed_projects,
    COUNT(*)::int AS total_projects,
    COALESCE(ROUND(AVG(calculated_progress_pct) FILTER(WHERE status NOT IN ('CLOSED','CANCELLED'))),0)::int AS avg_progress,
    COALESCE(SUM(budget),0)::numeric(15,2) AS total_budget,COALESCE(SUM(committed_value),0)::numeric(15,2) AS committed_value,
    COALESCE(SUM(paid_amount),0)::numeric(15,2) AS paid_amount,COALESCE(SUM(approved_amount),0)::numeric(15,2) AS approved_amount,
    COALESCE(SUM(gross_settled_amount),0)::numeric(15,2) AS gross_settled_amount,COALESCE(SUM(contractual_outstanding_amount),0)::numeric(15,2) AS contractual_outstanding_amount,
    COALESCE(SUM(pending_amount),0)::numeric(15,2) AS pending_amount,COALESCE(SUM(remaining_budget),0)::numeric(15,2) AS remaining_budget,
    COALESCE(SUM(outstanding_amount),0)::numeric(15,2) AS outstanding_amount,COALESCE(SUM(overdue_tasks),0)::int AS overdue_tasks,
    COALESCE(SUM(actual_cost),0)::numeric(15,2) AS total_actual_cost,COALESCE(SUM(pending_requests),0)::int AS pending_material_requests,
    COALESCE(SUM(location_count),0)::int AS total_locations,COALESCE(SUM(completed_location_count),0)::int AS completed_locations,COALESCE(SUM(active_locations),0)::int AS active_locations,
    COALESCE(SUM(active_vendor_commitments),0)::int AS active_vendor_commitments
    FROM metrics`,params),
   db.query(`${metrics} ORDER BY p.target_end_date NULLS LAST,p.id DESC`,params),
   db.query(`SELECT p.status,COUNT(*)::int AS count FROM construction_projects p WHERE ${where} GROUP BY p.status ORDER BY p.status`,params),
   db.query(`SELECT ${projectType} AS project_type,COUNT(*)::int AS count FROM construction_projects p WHERE ${where} GROUP BY ${projectType} ORDER BY count DESC`,params),
   capabilities.activity ? db.query(`SELECT a.*,u.name AS actor_name,p.name AS project_name FROM construction_project_activity a JOIN construction_projects p ON p.id=a.project_id LEFT JOIN users u ON u.id=a.actor_id WHERE ${activityWhere} ORDER BY a.id DESC LIMIT 12`,paymentParams) : Promise.resolve({rows:[]}),
   db.query(`SELECT vp.id,vp.commitment_id,vp.site_id,vp.payment_date,vp.amount,vp.payment_mode,vp.status,vp.cheque_status,vc.vendor_name,${commitmentProjectId} AS project_id,p.name AS project_name,
    COALESCE(posted.paid_amount,0)::numeric(15,2) AS posted_amount FROM vendor_payments vp JOIN vendor_commitments vc ON vc.id=vp.commitment_id JOIN construction_projects p ON p.id=${commitmentProjectId}
    LEFT JOIN LATERAL(SELECT SUM(le.debit-le.credit) paid_amount FROM ledger_entries le WHERE le.source_key='vendor_payments' AND le.source_id=vp.id AND le.ledger_type='site' AND le.site_id=p.site_id) posted ON true
    WHERE ${paymentWhere} ORDER BY vp.payment_date DESC,vp.id DESC LIMIT 12`,paymentParams),
 ]);
 return {summary:{...aggregate.rows[0],project_status_counts:statuses.rows,project_type_counts:types.rows,recent_activity:activity.rows,recent_payments:payments.rows,payment_history_restricted:!paymentVisibility.read||!paymentVisibility.all,projects:projects.rows.map(projectResponse)},projects:projects.rows.map(projectResponse)};
}
export const constructionSummary=asyncHandler(async(req,res)=> {
 const siteId=requireSite(req,res);if(!siteId)return;
 res.json(await getConstructionSummaryData({siteId,user:req.user,projectId:req.query.project_id,viewAll:req.constructionViewAll}));
});
