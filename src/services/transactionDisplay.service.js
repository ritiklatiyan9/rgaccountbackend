// Keep the Drive presentation aligned with src/lib/transactionParticulars.js
// in the frontend. Both deployments use the same display contract.
/** The plot identity shown in the Day Book table and its statements. */
const entryPlotNoOf = (entry) => {
  const direct = entry?.pp_plot_no || entry?.plot_no;
  if (direct) return String(direct).trim();
  // Consolidated statement rows expose the linked plot as "Plot A2 · Block …"
  // through `to_entity`; retain an exact token for older API responses too.
  for (const value of [entry?.to_entity, entry?.from_entity, entry?.linked_detail]) {
    const match = String(value || '').match(/(?:^|\b)plot\s*[:#-]?\s*([^·,()]+)/i);
    const candidate = match?.[1]?.trim();
    // Phrases such as "PLOT COMMISSION PAYMENT" describe the transaction,
    // not a plot number. Only use this legacy text fallback when it contains
    // a plausible plot token.
    if (candidate && !/^(commission|payment|commission\s+payment)\b/i.test(candidate)) return candidate;
  }
  return '';
};


const SOURCES = {
  day_book: ['Day Book', 'General'],
  expenses: ['Expenses', 'Expense'],
  farmer_payments: ['Lands Payments', 'Farmer payment'],
  personal_ledger: ['Personal Ledger', 'Person'],
  firm_transactions: ['Firm Transactions', 'Firm transaction'],
  plot_payments: ['Plot Payments', 'Plot payment'],
  plot_installment_payments: ['Installment Tracker', 'Plot installment'],
  plot_registry_payments: ['Plot Registry', 'Registry payment'],
  plot_commissions: ['Project Commission', 'Commission'],
  plot_commission_payments: ['Project Commission', 'Commission payment'],
  vendor_payments: ['Construction & Vendors', 'Vendor payment'],
  vendor_inventory_payments: ['Purchasing', 'Purchasing payment'],
  land_deal_payments: ['Land Sales', 'Land sale'],
  misc_income_entries: ['Miscellaneous Income', 'Miscellaneous income'],
  partner_profit_payments: ['Partner Profit', 'Profit distribution'],
  bank_statement_view: ['Bank Day Book', 'Bank statement'],
};
const PREFIXES = { expense: 'expenses', fp: 'farmer_payments', cf: 'personal_ledger', ft: 'firm_transactions', pp: 'plot_payments', pip: 'plot_installment_payments', prp: 'plot_registry_payments', comm: 'plot_commissions', pcp: 'plot_commission_payments', vp: 'vendor_payments', vip: 'vendor_inventory_payments', ldp: 'land_deal_payments', mie: 'misc_income_entries', ppp: 'partner_profit_payments' };
const TYPES = { EXPENSE: 'expenses', 'FARMER PAYMENT': 'farmer_payments', 'CASH FLOW': 'personal_ledger', 'PERSONAL LEDGER': 'personal_ledger', 'FIRM TRANSACTION': 'firm_transactions', 'PLOT PAYMENT': 'plot_payments', 'PLOT INSTALLMENT': 'plot_installment_payments', 'REGISTRY PAYMENT': 'plot_registry_payments', 'PLOT COMMISSION': 'plot_commissions', 'PLOT COMMISSION PAYMENT': 'plot_commission_payments', 'VENDOR PAYMENT': 'vendor_payments', 'PURCHASING PAYMENT': 'vendor_inventory_payments', 'LAND SALE RECEIPT': 'land_deal_payments', 'LAND SALE': 'land_deal_payments', 'MISC INCOME': 'misc_income_entries', 'MISCELLANEOUS INCOME': 'misc_income_entries', 'PARTNER PROFIT PAYMENT': 'partner_profit_payments', 'BANK STATEMENT': 'bank_statement_view' };
const clean = (value) => String(value ?? '').trim().replace(/\s+/g, ' ');
const key = (value) => clean(value).toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
const first = (...values) => values.map(clean).find(Boolean) || '';
const isContext = (value) => /^(?:person|site) ledger\b|^plot\s*[:#-]?\s*\S|^block\s+\S/i.test(clean(value));
const unique = (values, excluded = []) => {
  const seen = new Set(excluded.map(key));
  return values.map(clean).filter((value) => {
    if (!value || seen.has(key(value))) return false;
    seen.add(key(value));
    return true;
  });
};

export function transactionSourceKey(entry = {}) {
  for (const value of [entry.source_key, entry.source_module, clean(entry.order_key).split(':')[0]]) {
    if (SOURCES[value]) return value;
  }
  const linked = [['expense_id', 'expenses'], ['farmer_payment_id', 'farmer_payments'], ['commission_id', 'plot_commissions'], ['cash_flow_entry_id', 'personal_ledger'], ['firm_transaction_id', 'firm_transactions'], ['plot_payment_id', 'plot_payments'], ['vendor_payment_id', 'vendor_payments']];
  for (const [field, source] of linked) if (entry[field]) return source;
  return PREFIXES[clean(entry.id).split('_')[0]] || TYPES[clean(entry.entry_type).toUpperCase()] || 'day_book';
}

// Older ledger APIs put a generated description in entity_name. Recognize only
// the source's known narration format; ordinary payment descriptions stay intact.
function legacyParty(entry, source) {
  const text = first(entry.entity_name, entry.particular);
  const prefixes = {
    farmer_payments: /^FARMER PAYMENT\s*-\s*(.+)$/i,
    vendor_payments: /^VENDOR PAYMENT\s*-\s*(.+)$/i,
    plot_commission_payments: /^PLOT COMMISSION PAYMENT\s*-\s*(.+)$/i,
    land_deal_payments: /^LAND SALE\s*-\s*(.+)$/i,
    partner_profit_payments: /^PARTNER PROFIT\s*-\s*(.+)$/i,
    misc_income_entries: /^MISC INCOME(?: REFUND)?\s*-\s*[^]+?\s+-\s+(.+)$/i,
  };
  return text.match(prefixes[source])?.[1]?.trim() || '';
}

/** One presentation for daily module rows and consolidated ledger copies.
 * Never mutate particular/from/to: those are also used by the editing forms.
 */
export function transactionParticulars(entry = {}) {
  const source = transactionSourceKey(entry);
  const [module, defaultCategory] = SOURCES[source];
  const linked = first(entry.linked_detail, entry.statement_row ? entry.to_entity : '');
  const ledgerType = first(entry.ledger_type, linked.match(/^(person|site) ledger\b/i)?.[1]).toLowerCase();
  const ledgerName = first(entry.ledger_name, linked.match(/^(?:person|site) ledger\s*·\s*(.+?)(?:\s*·|$)/i)?.[1]);
  const entity = clean(entry.entity_name);
  const generatedEntity = entity && key(entity) === key(entry.particular);
  const plotNo = entryPlotNoOf(entry);
  const entities = (entry.statement_row ? [] : (Number(entry.debit) > 0
    ? [entry.to_entity, entry.from_entity] : [entry.from_entity, entry.to_entity]))
    .filter((value) => !plotNo || key(value) !== key(plotNo));
  const party = first(
    entry.party_name, entry.farmer_name, entry.pp_buyer_name, entry.buyer_name,
    entry.firm_name, entry.agent_name, entry.vendor_name,
    source === 'personal_ledger' && ledgerType !== 'site' ? ledgerName : '',
    generatedEntity ? legacyParty(entry, source) : entity,
    !entity ? legacyParty(entry, source) : '',
    ...entities.filter((value) => !isContext(value)),
    source === 'plot_commissions' ? entry.particular : '',
  );
  const rawCategory = clean(entry.category);
  const genericCategory = !rawCategory || key(rawCategory) === key(entry.entry_type)
    || ['cashflow', 'personalledger', source.replaceAll('_', '')].includes(key(rawCategory));
  const category = source === 'personal_ledger'
    ? (ledgerType === 'site' ? 'Site' : ledgerType === 'person' || ledgerName ? 'Person' : 'Ledger entry')
    : genericCategory ? (source === 'day_book' ? first(entry.entry_type, defaultCategory) : defaultCategory) : rawCategory;
  const categories = unique([category, entry.sub_category]).join(' / ');
  const linkedClient = clean(entry.linked_client_name);
  const nameLabel = !party && linkedClient ? 'Linked client' : '';
  const name = party || linkedClient || (source === 'bank_statement_view' ? first(entry.particular, 'Bank statement entry') : 'Party not specified');

  const block = first(entry.pp_block, entry.plot_block, linked.match(/(?:^|·)\s*Block\s+([^·]+)/i)?.[1]);
  const plot = plotNo ? `Plot ${plotNo}${block ? ` · Block ${block}` : ''}` : '';
  const context = linked.split(/\s*(?:·|→|>)\s*/).filter((part) => !/^(?:person|site) ledger\b/i.test(part)
    && key(part) !== key(ledgerName) && key(part) !== key(party)
    && !(plotNo && /^(?:plot|block)\s/i.test(part)));
  const narrative = clean(entry.particular);
  // Generated source headings already say the same category and party.
  const generatedNarrative = legacyParty({ particular: narrative }, source)
    || (linked && key(narrative) === key(linked) && /→|>|^(?:person|site) ledger\b/i.test(linked))
    || (party && [category, entry.entry_type].some((label) => key(narrative) === key(`${label} ${party}`)))
    || (plotNo && /^PLOT PAYMENT\s*-/i.test(narrative));
  const details = unique([
    generatedNarrative ? '' : narrative,
    plot,
    source === 'personal_ledger' && ledgerType === 'site' && ledgerName && key(ledgerName) !== key(name) ? `Ledger: ${ledgerName}` : '',
    ...context,
    ...entities.filter((value) => !isContext(value)),
    entry.firm_purpose,
    entry.father_name ? `S/O ${entry.father_name}` : '',
    [entry.plot_size, entry.plot_rate ? `Rate: ${entry.plot_rate}` : '', entry.commission_by_note].filter(Boolean).join(' · '),
    entry.interest_amount > 0 ? `Interest: ₹${Number(entry.interest_amount).toLocaleString('en-IN')}` : '',
    entry.firm_cheque_no ? `Cheque: ${entry.firm_cheque_no}` : '',
    entry.pp_bank_details,
    entry.remarks,
  ], [name, category, categories, module]);
  return { name, nameLabel, category: categories, module, details, source };
}

export function transactionParticularsText(entry) {
  const { name, nameLabel, category, module, details } = transactionParticulars(entry);
  return [nameLabel ? `${nameLabel}: ${name}` : name, `Category: ${category}`, `Module: ${module}`, ...details].join(' · ');
}
