import { withWalletVisibility, canViewAllWallets } from './walletVisibility.service.js';
import { hasRelation } from '../utils/schemaProbe.js';
import permissionModel from '../models/Permission.model.js';
import { visibleImprestPeople } from './imprestManagementAccess.service.js';
import { seekHistorySource } from './seekPermission.service.js';

// These are reads only. Sharing a history surface does not grant a new right to
// see staff requests; keep each module's current visibility rules.
export async function operationalHistorySources(db, actor, siteId, {source: requestedSource} = {}) {
  const sources = [];
  const wanted = source => !requestedSource || requestedSource === source;
  const admin = ['admin', 'super_admin'].includes(actor.role);
  if (wanted('edit_request') && await hasRelation('edit_requests')) sources.push({
    sql: `SELECT er.*, 'edit_request'::text AS source, 'edit'::text AS _type,
      s.name AS site_name,u.name AS created_by_name,u.name AS requested_by_name,
      reviewer.name AS reviewed_by_name, 'Edit request'::text AS module_label,
      COALESCE(er.proposed_data->>'buyer_name',er.original_data->>'buyer_name',er.original_data->>'name',er.module) AS entity_name,
      er.module AS entity_type
      FROM edit_requests er JOIN sites s ON s.id=COALESCE(er.site_id,
        CASE WHEN er.original_data->>'site_id' ~ '^[0-9]+$' THEN (er.original_data->>'site_id')::int END)
      LEFT JOIN users u ON u.id=er.requested_by LEFT JOIN users reviewer ON reviewer.id=er.reviewed_by
      WHERE s.id=$1 AND ($3::boolean OR er.requested_by=$2)`,
    params: [siteId, actor.id, admin],
  });
  if (wanted('seek_permission') && await hasRelation('seek_permissions')) sources.push(seekHistorySource(actor, siteId));
  if (['edit_request','seek_permission'].includes(requestedSource)) return sources;
  const walletActor = await withWalletVisibility(actor, db);
  const walletAll = canViewAllWallets(walletActor);
  if (wanted('wallet_transfer') && walletActor.wallet_can_read !== false && await hasRelation('loyalty_vault_transfers')) sources.push({
    sql: `SELECT t.*, 'wallet_transfer'::text AS source,'Cash Wallet'::text AS module_label,
      s.name AS site_name,sender.name AS created_by_name,recipient.name AS assigned_admin_name,
      CASE WHEN t.recipient_id=$2 THEN COALESCE(holder.name,member.full_name,sender.name) ELSE recipient.name END AS entity_name,
      'Cash handover'::text AS entity_type,t.note AS reason,
      CASE WHEN t.recipient_id=$2 THEN 0 ELSE t.amount END AS debit,
      CASE WHEN t.recipient_id=$2 THEN t.amount ELSE 0 END AS credit
      FROM loyalty_vault_transfers t JOIN sites s ON s.id=t.site_id
      LEFT JOIN users sender ON sender.id=t.sender_id LEFT JOIN users recipient ON recipient.id=t.recipient_id
      LEFT JOIN users holder ON t.from_holder_type='user' AND holder.id=t.from_holder_id
      LEFT JOIN members member ON t.from_holder_type='member' AND member.id=t.from_holder_id
      WHERE t.site_id=$1 AND t.organization_id=$3 AND ($4::boolean OR t.sender_id=$2 OR t.recipient_id=$2 OR (t.from_holder_type='user' AND t.from_holder_id=$2))`,
    params: [siteId, actor.id, actor.organization_id || 1, walletAll],
  });
  const permission = module => actor.permissionsByModule instanceof Map && actor.permissionsByModule.has(module)
    ? actor.permissionsByModule.get(module) : permissionModel.getPermission(actor.id, module);
  const personal = admin || (await permission('imprest'))?.can_read === true;
  const management = admin || (await permission('imprest_management'))?.can_read === true;
  if (wanted('wallet_imprest_transfer') && (walletActor.wallet_can_read !== false || personal || management) && await hasRelation('wallet_imprest_transfers')) sources.push({
    sql: `SELECT t.*, 'wallet_imprest_transfer'::text AS source,'Wallet to Imprest'::text AS module_label,
      s.name AS site_name,requester.name AS created_by_name,recipient.name AS assigned_admin_name,
      CASE WHEN t.to_user_id=$2 THEN sender.name ELSE recipient.name END AS entity_name,
      'Imprest transfer'::text AS entity_type,t.note AS reason,
      CASE WHEN t.to_user_id=$2 THEN 0 ELSE t.amount END AS debit,
      CASE WHEN t.to_user_id=$2 THEN t.amount ELSE 0 END AS credit
      FROM wallet_imprest_transfers t JOIN sites s ON s.id=t.site_id
      LEFT JOIN users requester ON requester.id=t.requested_by
      LEFT JOIN users sender ON sender.id=t.from_user_id LEFT JOIN users recipient ON recipient.id=t.to_user_id
      WHERE t.site_id=$1 AND t.organization_id=$3 AND ($4::boolean OR $2 IN(t.from_user_id,t.to_user_id,t.requested_by))`,
    params: [siteId, actor.id, actor.organization_id || 1, walletAll],
  });
  if (['wallet_transfer','wallet_imprest_transfer'].includes(requestedSource) || !personal && !management) return sources;
  const visible = management && !admin ? await visibleImprestPeople(db, actor, siteId) : [];
  visible.sort((a,b)=>a-b);
  const params = [siteId, actor.id, admin, personal, management, visible];
  for (const [table, type, source, label, credit] of [
    ['imprest_expense_requests', 'imprest', 'imprest', 'Imprest request', false],
    ['imprest_returns', 'imprest_return', 'imprest_return', 'Imprest return', true],
    ['imprest_allocations', 'allocation', 'imprest_allocation', 'Imprest handover', true],
  ]) {
    if (!wanted(source) || !await hasRelation(table)) continue;
    const allocation = type === 'allocation';
    const requester = allocation ? 'r.admin_id' : 'r.sub_admin_id';
    const visibility = allocation
      ? '($3 OR ($4 AND (r.sub_admin_id=$2 OR r.admin_id=$2)) OR ($5 AND r.sub_admin_id=ANY($6::int[])))'
      : '($3 OR ($4 AND (r.sub_admin_id=$2 OR r.assigned_admin_id=$2)) OR ($5 AND r.sub_admin_id=ANY($6::int[])))';
    sources.push({ sql: `SELECT r.*, '${source}'::text AS source,'${type}'::text AS _type,
      '${label}'::text AS module_label, '${label}'::text AS activity_label,
      s.name AS site_name,holder.name AS entity_name,'Imprest holder'::text AS entity_type,
      holder.name AS sub_admin_name,requester.name AS created_by_name,reviewer.name AS assigned_admin_name,
      ${credit ? '0::numeric AS debit,r.amount AS credit' : 'r.amount AS debit,0::numeric AS credit'}
      FROM ${table} r JOIN sites s ON s.id=r.site_id
      LEFT JOIN users holder ON holder.id=r.sub_admin_id
      LEFT JOIN users requester ON requester.id=${requester}
      LEFT JOIN users reviewer ON reviewer.id=r.assigned_admin_id
      WHERE r.site_id=$1 AND ${visibility}`, params });
  }
  return sources;
}
