import permissionModel from '../models/Permission.model.js';
import { projectAccessPredicate } from './constructionWorkflow.service.js';

// This scope is server supplied, never accepted from query/body input. Expenses
// permission alone must not reveal another user's construction assignments.
export async function constructionExpenseScope(user) {
  if (['admin', 'super_admin'].includes(user?.role)) {
    return { vendor_user_id: Number(user.id), vendor_all: true, vendor_site_all: true, vendor_rows_all: true, include_vendor: true };
  }
  const [vendors, construction] = await Promise.all([
    permissionModel.getPermission(user.id, 'vendors'),
    permissionModel.getPermission(user.id, 'construction'),
  ]);
  return {
    vendor_user_id: Number(user.id),
    vendor_all: construction?.can_view_all === true,
    vendor_site_all: false,
    vendor_rows_all: vendors?.can_view_all === true,
    include_vendor: vendors?.can_read === true,
  };
}

export function vendorExpensePredicate(filters, params) {
  // Internal model calls without a request scope exclude vendor records.
  if (filters.include_vendor !== true) return 'FALSE';
  if (filters.vendor_all === true && !filters.vendor_user_id) return 'FALSE';
  params.push(filters.vendor_user_id, filters.vendor_all === true, filters.vendor_site_all === true, filters.vendor_rows_all === true);
  const user = `$${params.length - 3}`;
  const all = `$${params.length - 2}`;
  return `EXISTS (
    SELECT 1 FROM vendor_commitments scope_commitment
    LEFT JOIN construction_projects scope_project ON scope_project.id = scope_commitment.project_id
    WHERE scope_commitment.id = vp.commitment_id AND scope_commitment.site_id = vp.site_id
      AND ($${params.length - 1}::boolean OR EXISTS (SELECT 1 FROM user_sites us WHERE us.user_id = ${user} AND us.site_id = vp.site_id))
      AND ($${params.length}::boolean OR vp.created_by = ${user})
      AND ((scope_project.id IS NULL AND (${all}::boolean OR vp.created_by = ${user} OR vp.assigned_admin_id = ${user}))
        OR (scope_project.site_id = vp.site_id AND ${projectAccessPredicate('scope_project', user, all)}))
  )`;
}

export function vendorExpenseCreationConflict(body) {
  return ['source_vendor_payment_id', 'vendor_payment_id', 'commitment_id'].some(key => body[key] != null)
    || String(body.category || '').trim().toUpperCase() === 'VENDOR PAYMENT';
}
