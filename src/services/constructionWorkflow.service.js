/** Shared construction authorization, validation and canonical financial projections. */
export const constructionError = (statusCode, message) => Object.assign(new Error(message), { statusCode, status: statusCode });
export const isConstructionAdmin = user => ['admin', 'super_admin'].includes(user?.role);
export const positiveId = value => {
  if(!/^\d+$/.test(String(value??'')))return null;
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
};
export const PROJECT_TRANSITIONS = Object.freeze({
  NEED: ['REVIEW', 'CANCELLED'], PLANNING: ['NEED', 'REVIEW', 'CANCELLED'],
  REVIEW: ['NEED', 'APPROVED', 'CANCELLED'], APPROVED: ['REVIEW', 'COMMITTED', 'CANCELLED'],
  COMMITTED: ['IN_PROGRESS', 'ON_HOLD', 'CANCELLED'],
  IN_PROGRESS: ['ON_HOLD', 'COMPLETED'], ACTIVE: ['IN_PROGRESS', 'ON_HOLD', 'DELAYED', 'COMPLETED'],
  DELAYED: ['IN_PROGRESS', 'ON_HOLD', 'COMPLETED'], ON_HOLD: ['IN_PROGRESS', 'CANCELLED'],
  COMPLETED: ['CLOSED', 'IN_PROGRESS'], CLOSED: [], CANCELLED: [],
});
export const validateProjectTransition = (from, to) => {
  if (!Object.hasOwn(PROJECT_TRANSITIONS, to)) throw constructionError(400, 'Invalid project status');
  if (from !== to && !PROJECT_TRANSITIONS[from]?.includes(to)) throw constructionError(409, `Project cannot move from ${from} to ${to}`);
};
export const decimalAmount = (value, label = 'Amount', { allowZero = false } = {}) => {
  const raw = String(value ?? '').trim();
  if (!/^\d{1,12}(\.\d{1,2})?$/.test(raw) || (!allowZero && /^0+(\.0+)?$/.test(raw))) {
    throw constructionError(400, `${label} must be ${allowZero ? 'a non-negative' : 'a positive'} amount with at most two decimal places`);
  }
  return raw;
};
export const dateValue = (value, label = 'Date') => {
  if (value === '' || value == null) return null;
  const text = value instanceof Date ? value.toISOString().slice(0,10) : String(value);
  const parsed = new Date(`${text}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== text) throw constructionError(400, `${label} must be a valid date`);
  return text;
};
export const validateDateRange = (start, end) => {
  if (start && end && dateValue(start) > dateValue(end)) throw constructionError(400, 'End date must be on or after start date');
};
export const progressValue = value => {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 100) throw constructionError(400, 'Progress must be an integer between 0 and 100');
  return n;
};

export async function assertConstructionSiteAccess(db, user, siteId) {
  if (!positiveId(siteId)) throw constructionError(400, 'site_id is required');
  const { rows } = await db.query('SELECT id FROM sites WHERE id = $1 AND organization_id=$2', [siteId,user.organization_id || 1]);
  if (!rows[0]) throw constructionError(404, 'Site not found');
  if (isConstructionAdmin(user)) return;
  if (user?.role !== 'sub_admin' || !(await db.query('SELECT 1 FROM user_sites WHERE user_id = $1 AND site_id = $2 LIMIT 1', [user.id, siteId])).rows[0]) throw constructionError(403, 'Access denied to this site');
}
export async function constructionCanViewAll(db, user) {
  if (isConstructionAdmin(user)) return true;
  const { rows } = await db.query("SELECT can_view_all FROM user_permissions WHERE user_id=$1 AND module='construction'", [user.id]);
  return rows[0]?.can_view_all === true;
}
export async function constructionPaymentVisibility(db,user) {
  if(isConstructionAdmin(user))return {read:true,all:true};
  const {rows}=await db.query("SELECT can_read,can_view_all FROM user_permissions WHERE user_id=$1 AND module='vendors'",[user.id]);
  return {read:rows[0]?.can_read===true,all:rows[0]?.can_view_all===true};
}
export function projectAccessPredicate(alias = 'p', userPlaceholder = '$2', allPlaceholder = '$3', { legacySafe = false } = {}) {
  // Only trusted SQL aliases/placeholders from server code are accepted.
  if (!/^[a-z][a-z0-9_]*$/i.test(alias) || !/^\$\d+$/.test(userPlaceholder) || !/^\$\d+$/.test(allPlaceholder)) throw new Error('Invalid construction scope SQL arguments');
  // Vendor reads must remain available before the optional assignment migration.
  // An absent assignment is NULL, never an implicit grant. Default project
  // workflows retain direct columns/indexes and their migration prerequisites.
  const owner = legacySafe ? `(to_jsonb(${alias})->>'owner_user_id')::integer` : `${alias}.owner_user_id`;
  const approver = legacySafe ? `(to_jsonb(${alias})->>'assigned_approver_id')::integer` : `${alias}.assigned_approver_id`;
  const taskOwner = legacySafe ? `(to_jsonb(assigned_task)->>'owner_user_id')::integer` : 'assigned_task.owner_user_id';
  return `(${allPlaceholder}::boolean OR ${alias}.created_by=${userPlaceholder} OR ${owner}=${userPlaceholder} OR ${alias}.assigned_admin_id=${userPlaceholder} OR ${approver}=${userPlaceholder} OR EXISTS (SELECT 1 FROM construction_tasks assigned_task WHERE assigned_task.project_id=${alias}.id AND ${taskOwner}=${userPlaceholder}))`;
}
export async function assertConstructionProjectAccess(db, user, projectId, siteId, { lock = false } = {}) {
  await assertConstructionSiteAccess(db, user, siteId);
  const all = await constructionCanViewAll(db, user);
  const { rows } = await db.query(`SELECT p.* FROM construction_projects p WHERE p.id=$1 AND p.site_id=$2 AND ${projectAccessPredicate('p', '$3', '$4')}${lock ? ' FOR UPDATE OF p' : ''}`, [projectId, siteId, user.id, all]);
  if (!rows[0]) throw constructionError(404, 'Project not found or access denied');
  return rows[0];
}
export async function validateConstructionAssignment(db, siteId, value, { approver = false, approvalModule = 'expense_approval' } = {}) {
  if (value === null || value === undefined || value === '') return null;
  const id = positiveId(value);
  if (!id) throw constructionError(400, 'Select a valid assigned user');
  const { rows } = await db.query(`SELECT u.id FROM users u JOIN sites assignment_site ON assignment_site.id=$2 AND assignment_site.organization_id=u.organization_id WHERE u.id=$1 AND u.is_active=true AND
    (u.role IN ('admin','super_admin') OR (u.role='sub_admin' AND EXISTS(SELECT 1 FROM user_sites us WHERE us.user_id=u.id AND us.site_id=$2)
      AND (NOT $3::boolean OR EXISTS(SELECT 1 FROM user_permissions up WHERE up.user_id=u.id AND up.module=$4 AND CASE WHEN $4='construction' THEN up.can_update ELSE up.can_read END=true))))`, [id, siteId, approver, approvalModule]);
  if (!rows[0]) throw constructionError(400, approver ? 'Approver must be active, assigned to this site and have approval permission' : 'Assigned user must be active and have access to this site');
  return id;
}
export async function recordConstructionActivity(db, { projectId, actorId, action, entityType = 'project', entityId = null, details = {} }) {
  await db.query(`INSERT INTO construction_project_activity(project_id,actor_id,action,entity_type,entity_id,details) VALUES($1,$2,$3,$4,$5,$6::jsonb)`, [projectId, actorId, action, entityType, entityId, JSON.stringify(details)]);
}
export async function markProjectCommitted(db, user, projectId, siteId, commitmentId) {
  if (!projectId) return;
  const project = await assertConstructionProjectAccess(db, user, projectId, siteId, { lock: true });
  if (!['APPROVED','COMMITTED','IN_PROGRESS','ON_HOLD','ACTIVE','DELAYED'].includes(project.status)) throw constructionError(409, 'Project must be approved before a vendor commitment is created');
  if (project.status === 'APPROVED') await db.query("UPDATE construction_projects SET status='COMMITTED',updated_at=NOW() WHERE id=$1", [projectId]);
  await recordConstructionActivity(db, { projectId, actorId: user.id, action: 'vendor_committed', entityType: 'commitment', entityId: commitmentId });
}

// Read financial amounts only from canonical site ledger rows. Pending and approved
// workflow amounts describe source states and are never added to ledger paid.
export function buildProjectMetricsSql({ legacySafe = false, locationsAvailable = true } = {}) {
 const ownerId = legacySafe ? "(to_jsonb(p)->>'owner_user_id')::integer" : 'p.owner_user_id';
 const approverId = legacySafe ? "(to_jsonb(p)->>'assigned_approver_id')::integer" : 'p.assigned_approver_id';
 const commitmentProjectId = legacySafe ? "(to_jsonb(vc)->>'project_id')::integer" : 'vc.project_id';
 const locationMetrics = locationsAvailable
   ? "SELECT COUNT(*) location_count,COUNT(*) FILTER(WHERE status='COMPLETED') completed_locations,COUNT(*) FILTER(WHERE status='ACTIVE') active_locations FROM construction_locations WHERE project_id=p.id"
   : 'SELECT 0::int location_count,0::int completed_locations,0::int active_locations';
 return `
 SELECT p.*,
   COALESCE(t.task_count,0)::int AS task_count, COALESCE(t.done_count,0)::int AS done_task_count,
   COALESCE(t.overdue_tasks,0)::int AS overdue_tasks,
   COALESCE(t.task_progress,p.progress_pct)::int AS calculated_progress_pct,
   COALESCE(c.committed_value,0)::numeric(15,2) AS committed_value,
   COALESCE(c.vendor_count,0)::int AS vendor_commitment_count,
   COALESCE(c.active_vendor_commitments,0)::int AS active_vendor_commitments,
   COALESCE(pay.paid_amount,0)::numeric(15,2) AS paid_amount,
   COALESCE(pay.approved_amount,0)::numeric(15,2) AS approved_amount,
   COALESCE(pay.gross_settled_amount,0)::numeric(15,2) AS gross_settled_amount,
   (COALESCE(c.committed_value,0)-COALESCE(pay.gross_settled_amount,0))::numeric(15,2) AS contractual_outstanding_amount,
   COALESCE(pay.pending_amount,0)::numeric(15,2) AS pending_amount,
   (p.budget-COALESCE(pay.paid_amount,0))::numeric(15,2) AS remaining_budget,
   (COALESCE(c.committed_value,0)-COALESCE(pay.paid_amount,0))::numeric(15,2) AS outstanding_amount,
   (p.budget-COALESCE(c.committed_value,0))::numeric(15,2) AS uncommitted_budget,
   COALESCE(cost.actual_cost,0)::numeric(15,2) AS actual_cost,
   COALESCE(loc.location_count,0)::int AS location_count,
   COALESCE(loc.completed_locations,0)::int AS completed_location_count,
   COALESCE(loc.active_locations,0)::int AS active_locations,
   COALESCE(mr.pending_requests,0)::int AS pending_requests,
   owner.name AS owner_name, approver.name AS assigned_approver_name, aa.name AS assigned_admin_name,
   (p.target_end_date<CURRENT_DATE AND p.status NOT IN ('COMPLETED','CLOSED','CANCELLED')) AS is_overdue
 FROM construction_projects p
 LEFT JOIN users owner ON owner.id=${ownerId} LEFT JOIN users approver ON approver.id=${approverId} LEFT JOIN users aa ON aa.id=p.assigned_admin_id
 LEFT JOIN LATERAL (SELECT COUNT(*) task_count, COUNT(*) FILTER(WHERE status='DONE') done_count,
    COUNT(*) FILTER(WHERE due_date<CURRENT_DATE AND status<>'DONE') overdue_tasks,
    ROUND(AVG(CASE WHEN status='DONE' THEN 100 ELSE progress_pct END)) task_progress FROM construction_tasks WHERE project_id=p.id) t ON true
 LEFT JOIN LATERAL (SELECT COUNT(*) vendor_count,COUNT(*) FILTER(WHERE status='open') active_vendor_commitments,SUM(contract_amount) committed_value FROM vendor_commitments vc WHERE ${commitmentProjectId}=p.id AND status<>'cancelled') c ON true
 LEFT JOIN LATERAL (SELECT SUM(lp.paid_amount) paid_amount,
    SUM(vp.amount+COALESCE(vp.tds_amount,0)) FILTER(WHERE financial_transaction_posts('debit',vp.status,vp.payment_mode,vp.cheque_status)) gross_settled_amount,
    SUM(vp.amount) FILTER(WHERE vp.status='approved') approved_amount,
    SUM(vp.amount) FILTER(WHERE vp.status='pending') pending_amount
    FROM vendor_payments vp JOIN vendor_commitments vc ON vc.id=vp.commitment_id
    LEFT JOIN LATERAL (SELECT SUM(le.debit-le.credit) paid_amount FROM ledger_entries le WHERE le.source_key='vendor_payments' AND le.source_id=vp.id AND le.ledger_type='site' AND le.site_id=p.site_id) lp ON true
    WHERE ${commitmentProjectId}=p.id) pay ON true
 LEFT JOIN LATERAL (SELECT SUM(qty*rate) actual_cost FROM inventory_movements WHERE project_id=p.id AND movement_type='CONSUMPTION') cost ON true
 LEFT JOIN LATERAL (${locationMetrics}) loc ON true
 LEFT JOIN LATERAL (SELECT COUNT(*) pending_requests FROM construction_material_requests WHERE project_id=p.id AND status IN ('REQUESTED','PARTIALLY_FULFILLED')) mr ON true
`;
}

export const projectMetricsSql = buildProjectMetricsSql();
