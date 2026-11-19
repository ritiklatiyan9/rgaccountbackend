import { withWalletVisibility, canViewAllWallets } from './walletVisibility.service.js';
import { hasRelation } from '../utils/schemaProbe.js';
import permissionModel from '../models/Permission.model.js';
import { visibleImprestPeople } from './imprestManagementAccess.service.js';
import { seekHistorySource } from './seekPermission.service.js';

const imprestVisibility = (alias, allocation) =>
  `($3 OR ($4 AND (${alias}.sub_admin_id=$2 OR ${alias}.${allocation ? 'admin_id' : 'assigned_admin_id'}=$2))
    OR ($5 AND ${alias}.sub_admin_id=ANY($6::int[])))`;

// The receipt posting records the originating request number. A manual
// handover with the same amount, recipient and date is a separate event.
const requestHandoverMatch = (request, handover) => `
  ${request}.request_type='IMPREST' AND ${request}.status='APPROVED' AND ${handover}.status='RECEIVED'
  AND ${request}.site_id=${handover}.site_id AND ${request}.sub_admin_id=${handover}.sub_admin_id
  AND ${request}.reviewed_by=${handover}.admin_id AND ${request}.amount=${handover}.amount
  AND EXISTS (
    SELECT 1 FROM imprest_ledger receipt
    WHERE receipt.site_id=${handover}.site_id AND receipt.user_id=${handover}.sub_admin_id
      AND receipt.reference_id=${handover}.id AND receipt.amount=${handover}.amount
      AND receipt.created_by=${handover}.admin_id
      AND ((receipt.type='ALLOCATION' AND receipt.remarks LIKE 'Imprest allocated (request #' || ${request}.id || ' approved)%')
        OR (receipt.type='TRANSFER_IN' AND receipt.remarks LIKE 'Imprest request #' || ${request}.id || ' funded by %'))
  )`;

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
  const linkHandovers = wanted('imprest') && (await Promise.all(
    ['imprest_expense_requests', 'imprest_allocations', 'imprest_ledger'].map(hasRelation)
  )).every(Boolean);
  for (const [table, type, source, label, credit] of [
    ['imprest_expense_requests', 'imprest', 'imprest', 'Imprest request', false],
    ['imprest_returns', 'imprest_return', 'imprest_return', 'Imprest return', true],
    ['imprest_allocations', 'allocation', 'imprest_allocation', 'Imprest handover', true],
  ]) {
    if (!wanted(source) || !await hasRelation(table)) continue;
    const allocation = type === 'allocation';
    const requester = allocation ? 'r.admin_id' : 'r.sub_admin_id';
    const handoverDetails = type === 'imprest' && linkHandovers ? `, (
      SELECT jsonb_build_object('id', a.id, 'received_at', COALESCE(a.confirmed_at,a.created_at),
        'sender_name', sender.name, 'label', 'Cash handover')
      FROM imprest_allocations a LEFT JOIN users sender ON sender.id=a.admin_id
      WHERE ${requestHandoverMatch('r', 'a')} AND ${imprestVisibility('a', true)}
      ORDER BY a.id LIMIT 1
    ) AS imprest_handover` : '';
    // Keep direct handovers and the explicit handover filter. In the combined
    // feed use the request row only when the viewer can also see that request.
    const hideLinkedHandover = allocation && linkHandovers && !requestedSource ? `
      AND NOT EXISTS (
        SELECT 1 FROM imprest_expense_requests request
        WHERE ${requestHandoverMatch('request', 'r')} AND ${imprestVisibility('request', false)}
      )` : '';
    sources.push({ sql: `SELECT r.*, '${source}'::text AS source,'${type}'::text AS _type,
      '${label}'::text AS module_label, '${label}'::text AS activity_label,
      s.name AS site_name,holder.name AS entity_name,'Imprest holder'::text AS entity_type,
      holder.name AS sub_admin_name,requester.name AS created_by_name,reviewer.name AS assigned_admin_name,
      ${credit ? '0::numeric AS debit,r.amount AS credit' : 'r.amount AS debit,0::numeric AS credit'}${handoverDetails}
      FROM ${table} r JOIN sites s ON s.id=r.site_id
      LEFT JOIN users holder ON holder.id=r.sub_admin_id
      LEFT JOIN users requester ON requester.id=${requester}
      LEFT JOIN users reviewer ON reviewer.id=r.assigned_admin_id
      WHERE r.site_id=$1 AND ${imprestVisibility('r', allocation)}${hideLinkedHandover}`, params });
  }
  return sources;
}
