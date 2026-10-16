import { LOYALTY_VAULT_SOURCE_TABLES } from './loyaltyVaultContext.service.js';

// Resolve the recorded source's display context, never its financial mirrors.
// Parent identities must belong to the movement's site as well as the source.
const sourceOwners = {
  farmer_payments: { table: 'farmers', field: 'farmer_id', party: "to_jsonb(owner)->>'name'" },
  firm_transactions: { table: 'firms', field: 'firm_id', party: "to_jsonb(owner)->>'name'", fields: { firm_name: "to_jsonb(owner)->>'name'" } },
  vendor_payments: { table: 'vendor_commitments', field: 'commitment_id', party: "to_jsonb(owner)->>'vendor_name'", fields: { work_title: "to_jsonb(owner)->>'work_title'" } },
  vendor_inventory_payments: { table: 'vendor_inventory_orders', field: 'order_id', party: "to_jsonb(owner)->>'vendor_name'", fields: { item_name: "to_jsonb(owner)->>'item_name'", category: "to_jsonb(owner)->>'item_category'" } },
  land_deal_payments: { table: 'land_deals', field: 'land_deal_id', party: "to_jsonb(owner)->>'buyer_name'", fields: { deal_no: "to_jsonb(owner)->>'deal_no'" } },
  cash_flow_entries: { table: 'cash_flow_months', field: 'cash_flow_month_id', party: "CASE WHEN to_jsonb(owner)->>'ledger_type'='person' THEN to_jsonb(owner)->>'ledger_name' ELSE to_jsonb(native)->>'to_name' END", fields: { ledger_name: "to_jsonb(owner)->>'ledger_name'", ledger_type: "to_jsonb(owner)->>'ledger_type'" } },
  misc_income_entries: { table: 'misc_income_categories', field: 'category_id', shared: true, fields: { category: "to_jsonb(owner)->>'name'" } },
  partner_profit_payments: { table: 'members', field: 'member_id', shared: true, party: 'owner.full_name' },
  plot_commission_payments: { table: 'plot_commissions_v2', field: 'plot_commission_id', party: 'commission_agent.full_name', joins: `
    LEFT JOIN members commission_agent ON commission_agent.id=NULLIF(to_jsonb(owner)->>'agent_id','')::integer
    LEFT JOIN plots commission_plot ON commission_plot.id=NULLIF(to_jsonb(owner)->>'plot_id','')::integer AND commission_plot.site_id=e.site_id`,
    fields: { plot_no: "to_jsonb(commission_plot)->>'plot_no'", plot_block: "to_jsonb(commission_plot)->>'block'", buyer_name: "to_jsonb(commission_plot)->>'buyer_name'" } },
};
const displayFields = ['party_name','category','sub_category','from_entity','to_entity','ledger_name','ledger_type','firm_name','farmer_name','vendor_name','agent_name','work_title','item_name','deal_no'];
const sourceRows = [...LOYALTY_VAULT_SOURCE_TABLES].map(table => {
  const owner = sourceOwners[table];
  const fields = Object.fromEntries(displayFields.map(field => [field, `NULLIF(BTRIM(to_jsonb(native)->>'${field}'),'')`]));
  if (owner?.party) fields.party_name = `COALESCE(${fields.party_name},${owner.party})`;
  for (const [field, expression] of Object.entries(owner?.fields || {})) fields[field] = `COALESCE(${fields[field] || 'NULL'},${expression})`;
  const metadata = Object.entries(fields).flatMap(([field, expression]) => [`'${field}'`, expression]).join(',');
  return `SELECT to_jsonb(native) AS record,jsonb_strip_nulls(jsonb_build_object(${metadata})) AS particulars
    FROM ${table} native
    ${owner ? `LEFT JOIN ${owner.table} owner ON owner.id=NULLIF(to_jsonb(native)->>'${owner.field}','')::integer${owner.shared ? '' : ' AND owner.site_id=e.site_id'}` : ''}
    ${owner?.joins || ''}
    WHERE e.source_table='${table}' AND native.id=e.source_id
      AND loyalty_vault_source_site('${table}',to_jsonb(native))=e.site_id`;
}).join('\nUNION ALL\n');

const moduleName = `CASE e.source_table
  WHEN 'cash_flow_entries' THEN 'Cash Flow' WHEN 'day_book' THEN 'Day Book'
  WHEN 'expenses' THEN 'Expenses' WHEN 'farmer_payments' THEN 'Farmer Payments'
  WHEN 'firm_transactions' THEN 'Firm Transactions' WHEN 'plot_payments' THEN 'Plot Payments'
  WHEN 'plot_installment_payments' THEN 'Plot Installments' WHEN 'plot_commission_payments' THEN 'Commission Payments'
  WHEN 'vendor_payments' THEN 'Vendor Payments' WHEN 'vendor_inventory_payments' THEN 'Vendor Inventory'
  WHEN 'land_deal_payments' THEN 'Land Deals' WHEN 'misc_income_entries' THEN 'Miscellaneous Income'
  WHEN 'partner_profit_payments' THEN 'Partner Profit'
  WHEN 'imprest_allocations' THEN 'Imprest' WHEN 'imprest_transfers' THEN 'Imprest'
  WHEN 'imprest_returns' THEN 'Imprest' WHEN 'imprest_ledger' THEN 'Imprest'
  ELSE CASE WHEN e.transfer_id IS NOT NULL THEN 'Wallet Transfer' ELSE 'Cash Wallet' END END`;

export const walletHistoryJoins = `FROM site_history e
  LEFT JOIN users u ON e.holder_type='user' AND u.id=e.holder_id
  LEFT JOIN members m ON e.holder_type='member' AND m.id=e.holder_id
  LEFT JOIN sites s ON s.id=e.site_id LEFT JOIN users actor ON actor.id=e.actor_id
  LEFT JOIN loyalty_vault_transfers t ON t.id=e.transfer_id
  LEFT JOIN users sender ON t.from_holder_type='user' AND sender.id=t.from_holder_id
  LEFT JOIN members sender_member ON t.from_holder_type='member' AND sender_member.id=t.from_holder_id
  LEFT JOIN users recipient ON recipient.id=t.to_holder_id LEFT JOIN users resolver ON resolver.id=t.resolved_by
  LEFT JOIN LATERAL (${sourceRows}) wallet_source ON true
  LEFT JOIN cash_flow_entries cash ON cash.id=e.cash_flow_entry_id AND loyalty_vault_source_site('cash_flow_entries',to_jsonb(cash))=e.site_id
  LEFT JOIN plot_payments vault_pp ON e.source_table='plot_payments' AND vault_pp.id=e.source_id AND loyalty_vault_source_site('plot_payments',to_jsonb(vault_pp))=e.site_id
  LEFT JOIN plot_installment_payments vault_pip ON e.source_table='plot_installment_payments' AND vault_pip.id=e.source_id AND loyalty_vault_source_site('plot_installment_payments',to_jsonb(vault_pip))=e.site_id
  LEFT JOIN plot_installments vault_pi ON vault_pi.id=NULLIF(to_jsonb(vault_pip)->>'installment_id','')::integer
  LEFT JOIN plots vault_plot ON vault_plot.id=COALESCE(NULLIF(to_jsonb(vault_pp)->>'plot_id','')::integer,NULLIF(to_jsonb(vault_pip)->>'plot_id','')::integer,vault_pi.plot_id) AND vault_plot.site_id=e.site_id
  LEFT JOIN LATERAL (SELECT
    COALESCE(NULLIF(BTRIM(e.details->>'source_description'),''),
      NULLIF(BTRIM(wallet_source.record->>'description'),''),NULLIF(BTRIM(wallet_source.record->>'particular'),''),
      NULLIF(BTRIM(wallet_source.record->>'narration'),''),NULLIF(BTRIM(wallet_source.record->>'remark'),''),
      NULLIF(BTRIM(wallet_source.record->>'remarks'),''),NULLIF(BTRIM(wallet_source.record->>'note'),''),
      NULLIF(BTRIM(to_jsonb(cash)->>'particular'),''),e.description) AS source_description,
    COALESCE(NULLIF(e.details->>'remarks',''),NULLIF(wallet_source.record->>'remark',''),
      NULLIF(wallet_source.record->>'remarks',''),NULLIF(wallet_source.record->>'note','')) AS notes,
    COALESCE(NULLIF(e.details->>'reference',''),NULLIF(wallet_source.record->>'reference_no',''),
      NULLIF(wallet_source.record->>'bank_reference',''),NULLIF(wallet_source.record->>'transaction_id',''),
      NULLIF(wallet_source.record->>'voucher_no',''),NULLIF(wallet_source.record->>'receipt_no','')) AS reference,
    ${moduleName} AS module_name) context ON true`;

export const walletHistorySelect = `e.*,
  COALESCE(e.details->>'holder_name',u.name,m.full_name,'Former holder') AS holder_name,
  s.name AS site_name,actor.name AS actor_name,context.module_name,
  wallet_source.record->>'status' AS current_source_status,
  wallet_source.record->>'approved_at' AS current_source_reviewed_at,
  wallet_source.record->>'approved_by' AS current_source_reviewed_by,
  COALESCE(e.details->>'plot_no',to_jsonb(vault_plot)->>'plot_no') AS plot_no,
  COALESCE(e.details->>'buyer_name',NULLIF(BTRIM(to_jsonb(vault_plot)->>'buyer_name'),''),NULLIF(BTRIM(to_jsonb(vault_pp)->>'buyer_name'),'')) AS buyer_name,
  COALESCE(wallet_source.particulars,'{}'::jsonb)||e.details||jsonb_strip_nulls(jsonb_build_object(
    'source_description',context.source_description,'module_name',context.module_name,
    'notes',context.notes,'reference',context.reference,'site_name',s.name,'site_id',e.site_id,
    'parent_id',COALESCE(wallet_source.record->>'farmer_id',wallet_source.record->>'land_deal_id',wallet_source.record->>'firm_id',
      wallet_source.record->>'cash_flow_month_id',wallet_source.record->>'commitment_id',wallet_source.record->>'order_id'),
    'plot_id',COALESCE(NULLIF(e.details->>'plot_id','')::integer,vault_plot.id),
    'plot_no',COALESCE(e.details->>'plot_no',to_jsonb(vault_plot)->>'plot_no'),
    'buyer_name',COALESCE(e.details->>'buyer_name',to_jsonb(vault_plot)->>'buyer_name'),
    'plot_block',COALESCE(e.details->>'plot_block',to_jsonb(vault_plot)->>'block'),
    'source_available',CASE WHEN e.source_table IS NOT NULL THEN wallet_source.record IS NOT NULL ELSE NULL END
  )) AS source_details,
  COALESCE(e.details->>'transaction_date',wallet_source.record->>'date',wallet_source.record->>'payment_date') AS transaction_date,
  e.details->>'payment_mode' AS payment_mode,t.status AS transfer_status,t.note AS transfer_note,
  t.created_at AS requested_at,t.resolved_at,t.resolution_note,resolver.name AS resolved_by_name,
  COALESCE(sender.name,sender_member.full_name) AS from_holder_name,recipient.name AS to_holder_name,
  COALESCE(e.details->>'counterparty_name',CASE WHEN e.amount<0 THEN recipient.name ELSE COALESCE(sender.name,sender_member.full_name) END) AS counterparty_name`;

export const walletHistorySearch = `concat_ws(' ',e.description,context.source_description,context.module_name,
  e.source_table,e.source_id::text,e.transfer_id::text,u.name,m.full_name,s.name,actor.name,
  context.notes,context.reference,wallet_source.particulars::text,e.details->>'plot_no',to_jsonb(vault_plot)->>'plot_no',
  e.details->>'buyer_name',to_jsonb(vault_plot)->>'buyer_name',t.note,sender.name,sender_member.full_name,recipient.name)`;
