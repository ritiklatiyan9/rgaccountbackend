// Presentation metadata comes from the owner, never from generated ledger
// narration. Query only the identities already authorized by the statement.
const SOURCES = {
  expenses: {
    from: 'expenses s',
    party: "CASE WHEN s.debit > 0 THEN COALESCE(NULLIF(TRIM(s.to_entity), ''), NULLIF(TRIM(s.from_entity), '')) ELSE COALESCE(NULLIF(TRIM(s.from_entity), ''), NULLIF(TRIM(s.to_entity), '')) END",
    category: "COALESCE(NULLIF(TRIM(s.category), ''), 'Uncategorized')", subCategory: "to_jsonb(s)->>'sub_category'",
  },
  day_book: {
    from: 'day_book s',
    party: "CASE WHEN s.debit > 0 THEN COALESCE(NULLIF(TRIM(s.to_entity), ''), NULLIF(TRIM(s.from_entity), '')) ELSE COALESCE(NULLIF(TRIM(s.from_entity), ''), NULLIF(TRIM(s.to_entity), '')) END",
    category: 's.category',
  },
  personal_ledger: {
    from: 'cash_flow_entries s LEFT JOIN cash_flow_months owner ON owner.id = s.cash_flow_month_id',
    party: "CASE WHEN owner.ledger_type = 'person' THEN owner.ledger_name ELSE NULLIF(TRIM(s.to_name), '') END",
    ledgerName: 'owner.ledger_name', ledgerType: 'owner.ledger_type',
  },
  farmer_payments: { from: 'farmer_payments s LEFT JOIN farmers owner ON owner.id = s.farmer_id', party: 'owner.name' },
  plot_payments: { from: 'plot_payments s LEFT JOIN plots owner ON owner.id = s.plot_id', party: "COALESCE(NULLIF(TRIM(s.buyer_name), ''), owner.buyer_name)" },
  plot_installment_payments: { from: 'plot_installment_payments s LEFT JOIN plots owner ON owner.id = s.plot_id', party: 'owner.buyer_name' },
  plot_registry_payments: { from: 'plot_registry_payments s LEFT JOIN plot_registries master ON master.id = s.registry_id', party: 'master.customer_name' },
  plot_commissions: { from: 'plot_commissions s', party: 's.particular' },
  plot_commission_payments: { from: 'plot_commission_payments s LEFT JOIN plot_commissions_v2 master ON master.id = s.plot_commission_id LEFT JOIN members owner ON owner.id = master.agent_id', party: 'owner.full_name', category: "CASE WHEN master.plot_id IS NOT NULL THEN 'Plot commission' WHEN master.farmer_id IS NOT NULL THEN 'Land purchase commission' ELSE 'Land sale commission' END" },
  firm_transactions: { from: 'firm_transactions s LEFT JOIN firms owner ON owner.id = s.firm_id', party: 'owner.name' },
  vendor_payments: { from: 'vendor_payments s LEFT JOIN vendor_commitments owner ON owner.id = s.commitment_id', party: 'owner.vendor_name' },
  vendor_inventory_payments: { from: 'vendor_inventory_payments s LEFT JOIN vendor_inventory_orders owner ON owner.id = s.order_id', party: 'owner.vendor_name', category: 'owner.item_category' },
  land_deal_payments: { from: 'land_deal_payments s LEFT JOIN land_deals owner ON owner.id = s.land_deal_id', party: 'owner.buyer_name' },
  misc_income_entries: { from: 'misc_income_entries s LEFT JOIN misc_income_categories owner ON owner.id = s.category_id', party: 's.party_name', category: 'owner.name' },
  partner_profit_payments: { from: 'partner_profit_payments s LEFT JOIN members owner ON owner.id = s.member_id', party: 'owner.full_name' },
};
const LINK_TARGETS = {
  day_book: 'daybook', expenses: 'expense', farmer_payments: 'farmer_payment',
  personal_ledger: 'cashflow_entry', firm_transactions: 'firm_transaction',
  plot_payments: 'plot_payment', plot_commission_payments: 'commission_payment',
  plot_registry_payments: 'registry_payment', vendor_payments: 'vendor_payment',
  partner_profit_payments: 'partner_profit_payment', land_deal_payments: 'land_deal_payment',
  misc_income_entries: 'misc_income_entry',
};

function sourceOf(entry) {
  const [key, rawId] = String(entry.order_key || '').split(':');
  const source = entry.source_key || key;
  const id = Number(entry.source_id || rawId || String(entry.id || '').split(':')[0]);
  return SOURCES[source] && Number.isSafeInteger(id) && id > 0 ? { key: source, id } : null;
}

export async function attachTransactionParticulars(entries, db) {
  const groups = new Map();
  for (const entry of entries) {
    const source = sourceOf(entry);
    if (!source) continue;
    if (!groups.has(source.key)) groups.set(source.key, new Set());
    groups.get(source.key).add(source.id);
  }
  if (!groups.size) return entries;
  const params = [];
  const queries = [...groups].map(([key, ids]) => {
    const source = SOURCES[key];
    const target = LINK_TARGETS[key];
    params.push([...ids]);
    return `SELECT '${key}'::text AS source_key, s.id AS source_id,
      (${source.party})::text AS party_name,
      (${source.category || 'NULL'})::text AS category,
      (${source.subCategory || 'NULL'})::text AS sub_category,
      (${source.ledgerName || 'NULL'})::text AS ledger_name,
      (${source.ledgerType || 'NULL'})::text AS ledger_type,
      (${target ? 'linked_member.full_name' : 'NULL'})::text AS linked_client_name
      FROM ${source.from}
      ${target ? `LEFT JOIN transaction_party_links related ON related.source_key = '${target}' AND related.source_id = s.id AND related.site_id = s.site_id
        LEFT JOIN members linked_member ON linked_member.id = related.member_id` : ''}
      WHERE s.id = ANY($${params.length}::int[])`;
  });
  let rows;
  try {
    ({ rows } = await db.query(queries.join('\nUNION ALL\n'), params));
  } catch (error) {
    // An older deployment can lack an optional source table/column. Keep its
    // existing ledger display available while the schema catches up.
    if (!['42P01', '42703'].includes(error.code)) throw error;
    console.warn('[particulars] source metadata unavailable:', error.message);
    return entries;
  }
  const bySource = new Map(rows.map((row) => [`${row.source_key}:${row.source_id}`, row]));
  for (const entry of entries) {
    const source = sourceOf(entry);
    const metadata = source && bySource.get(`${source.key}:${source.id}`);
    if (!metadata) continue;
    for (const field of ['party_name', 'category', 'sub_category', 'ledger_name', 'ledger_type', 'linked_client_name']) {
      if (metadata[field] != null && String(metadata[field]).trim()) entry[field] = metadata[field];
    }
  }
  return entries;
}
