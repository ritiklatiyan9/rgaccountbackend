const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function chequeDateOnly(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.valueOf())) return null;
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
  }
  const text = String(value);
  return DATE_PATTERN.test(text.slice(0, 10)) ? text.slice(0, 10) : null;
}

export function validateChequeTransactionDate(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  const parsed = DATE_PATTERN.test(text) ? new Date(`${text}T00:00:00.000Z`) : null;
  if (!parsed || Number.isNaN(parsed.valueOf()) || text.startsWith('0000-') || parsed.toISOString().slice(0, 10) !== text) {
    throw Object.assign(new Error('Date of Transaction must be a valid date in YYYY-MM-DD format.'), {
      statusCode: 400, code: 'INVALID_CHEQUE_TRANSACTION_DATE',
    });
  }
  return text;
}

export function currentChequeBusinessDate(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const part = (type) => parts.find((item) => item.type === type).value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

const hasCheque = (row) => Boolean(String(row.cheque_status || '').trim())
  || [row.payment_mode, row.payment_type, row.cash_type, row.payment_from].some((mode) => ['CHEQUE', 'CHECK'].includes(String(mode || '').trim().toUpperCase()))
  || /\b(?:CHEQUE|CHECK)\b/i.test(String(row.by_note || ''));

// Ordinary saves cannot clear/reopen instruments by carrying lifecycle fields.
// Unchanged form values preserve clearance; a changed payment needs verification.
export function chequeStatusForPaymentEdit(existing, changes, modeField = 'payment_mode') {
  const isChequeMode = (value) => /\b(?:CHEQUE|CHECK)\b/i.test(String(value || ''));
  const nextMode = changes[modeField] === undefined ? existing[modeField] : changes[modeField];
  if (!isChequeMode(nextMode)) return null;
  const fields = [modeField, 'date', 'payment_date', 'amount', 'debit', 'credit', 'cash_amount', 'bank_amount', 'tds_amount',
    'bank_name', 'bank_account_id', 'bank_account_no', 'account_no', 'branch', 'bank_reference', 'bank_details', 'bank_ifsc', 'transaction_id', 'transaction_no', 'reference_no', 'cheque_no'];
  const comparable = (key, value) => {
    if (['date', 'payment_date'].includes(key)) return chequeDateOnly(value);
    if (['amount', 'debit', 'credit', 'cash_amount', 'bank_amount', 'tds_amount', 'bank_account_id'].includes(key)) return Number(value || 0);
    return String(value ?? '').trim().toUpperCase();
  };
  const changed = fields.some(key => changes[key] !== undefined && comparable(key, changes[key]) !== comparable(key, existing[key]));
  return !isChequeMode(existing[modeField]) || changed ? 'PENDING'
    : ['PENDING', 'CLEARED', 'BOUNCED', 'RETURNED'].includes(String(existing.cheque_status || '').toUpperCase())
      ? String(existing.cheque_status).toUpperCase() : 'PENDING';
}

const SOURCE_MODULES = Object.freeze({
  farmer_payment: 'farmer_payments', plot_commission: 'plot_commissions',
  plot_commission_payment: 'plot_commission_payments', commission: 'plot_commission_payments',
  firm_transaction: 'firm_transactions', plot_payment: 'plot_payments',
  plot_installment_payment: 'plot_installment_payments', expense: 'expenses',
  vendor_payment: 'vendor_payments', vendor_inventory_payment: 'vendor_inventory_payments',
  plot_registry_payment: 'plot_registry_payments', land_deal_payment: 'land_deal_payments',
  misc_income_entry: 'misc_income_entries', daybook: 'day_book',
  personal_ledger: 'cash_flow_entries', cash_flow_entry: 'cash_flow_entries',
});

/** Enrich a native list or a mixed projection in one site-scoped ledger read. */
export async function attachModuleChequeDates(rows, db, sourceModule, siteId) {
  const ledgerIdOf = (row) => Number(row.cheque_ledger_id || row.original_id || String(row.id).split(':')[0]);
  const moduleOf = (row) => {
    const raw = typeof sourceModule === 'function' ? sourceModule(row) : sourceModule || row.source;
    return SOURCE_MODULES[raw] || raw;
  };
  const unknownMirrors = rows.filter(row => hasCheque(row) && moduleOf(row) === 'cash_flow_entries' && !Object.hasOwn(row, 'source_module'));
  if (unknownMirrors.length) {
    const { rows: owners } = await db.query(`SELECT cfe.id, cfe.site_id, cfe.source_module, cfe.source_id,
      cfe.cheque_status, cfe.cheque_no, TO_CHAR(cfe.cheque_transaction_date, 'YYYY-MM-DD') AS cheque_transaction_date
      FROM jsonb_to_recordset($1::jsonb) AS requested(ledger_id int, site_id int)
      JOIN cash_flow_entries cfe ON cfe.id = requested.ledger_id AND cfe.site_id = requested.site_id`,
    [JSON.stringify(unknownMirrors.map(row => ({ ledger_id: ledgerIdOf(row), site_id: Number(row.site_id || siteId) })))]);
    const byId = new Map(owners.map(owner => [`${owner.site_id}:${owner.id}`, owner]));
    for (const row of unknownMirrors) {
      const owner = byId.get(`${row.site_id || siteId}:${ledgerIdOf(row)}`);
      if (owner) Object.assign(row, { source_module: owner.source_module, cheque_ledger_source_id: owner.source_id,
        cheque_status: owner.cheque_status, cheque_no: owner.cheque_no, cheque_transaction_date: owner.cheque_transaction_date });
    }
  }
  // A Personal Ledger can display another module's mirror. Resolve linked
  // allocations in one batch so its control acts on the original cheque.
  const projectionTables = { plot_registry_payments: ['source_plot_payment_id'], vendor_inventory_payments: ['source_vendor_payment_id'],
    day_book: ['farmer_payment_id', 'commission_id', 'cash_flow_entry_id', 'firm_transaction_id', 'plot_payment_id', 'vendor_payment_id'] };
  const mirrors = rows.filter((row) => hasCheque(row) && moduleOf(row) === 'cash_flow_entries' && projectionTables[row.source_module]);
  if (mirrors.length) {
    const requested = mirrors.map((row) => ({ ledger_id: ledgerIdOf(row), site_id: Number(row.site_id || siteId) }));
    const tables = [...new Set(mirrors.map((row) => row.source_module))];
    const selects = tables.map((table) => `SELECT cfe.id AS ledger_id, cfe.site_id,
      jsonb_build_object(${projectionTables[table].map(key => `'${key}', projection.${key}`).join(', ')}) AS links
      FROM requested JOIN cash_flow_entries cfe ON cfe.id = requested.ledger_id AND cfe.site_id = requested.site_id
      JOIN ${table} projection ON cfe.source_module = '${table}' AND projection.id = cfe.source_id AND projection.site_id = cfe.site_id`);
    const { rows: owners } = await db.query(`WITH requested AS (
      SELECT * FROM jsonb_to_recordset($1::jsonb) AS refs(ledger_id int, site_id int)
    ) ${selects.join(' UNION ALL ')}`, [JSON.stringify(requested)]);
    const byId = new Map(owners.map(owner => [`${owner.site_id}:${owner.ledger_id}`, owner.links]));
    for (const row of mirrors) Object.assign(row, byId.get(`${row.site_id || siteId}:${ledgerIdOf(row)}`) || {});
  }
  return attachChequeDates(rows, db, (row) => {
    const suppliedModule = moduleOf(row);
    const module = suppliedModule === 'cash_flow_entries' && projectionTables[row.source_module] ? row.source_module : suppliedModule;
    let identity = { siteId: row.site_id || siteId, sourceModule: module, sourceId: row.original_id || row.id };
    if (suppliedModule === 'cash_flow_entries') identity.sourceId = module !== suppliedModule ? row.cheque_ledger_source_id ?? row.source_id : ledgerIdOf(row);
    if (module === 'plot_commissions' && !String(row.cheque_status || '').trim()) identity.useOwnerMetadata = true;
    if (module === 'plot_registry_payments' && row.source_plot_payment_id) {
      identity = { ...identity, sourceModule: 'plot_payments', sourceId: row.source_plot_payment_id, useOwnerMetadata: true };
    }
    if (module === 'vendor_inventory_payments' && row.source_vendor_payment_id) {
      identity = { ...identity, sourceModule: 'vendor_payments', sourceId: row.source_vendor_payment_id, useOwnerMetadata: true };
    }
    if (module === 'day_book') {
      for (const [key, ownerModule] of Object.entries({ farmer_payment_id: 'farmer_payments', commission_id: 'plot_commissions',
        cash_flow_entry_id: 'cash_flow_entries', firm_transaction_id: 'firm_transactions', plot_payment_id: 'plot_payments', vendor_payment_id: 'vendor_payments' })) {
        if (row[key]) { identity = { ...identity, sourceModule: ownerModule, sourceId: row[key], useOwnerMetadata: true }; break; }
      }
    }
    row.cheque_source_module = identity.sourceModule === 'cash_flow_entries' && row.source_module
      ? row.source_module.replace(/_person$/, '') : identity.sourceModule;
    row.cheque_source_id = identity.sourceModule === 'cash_flow_entries' && row.source_module ? row.cheque_ledger_source_id ?? row.source_id : identity.sourceId;
    return identity;
  });
}

// A linked Day Book projection keeps its own amounts/approval/accounting date,
// while cheque metadata belongs to the original payment the user clears.
export function chequeMetadataFromOwner(owner) {
  return {
    cheque_status: owner.cheque_status ?? null,
    cheque_no: owner.cheque_no ?? null,
    cheque_apply_date: chequeDateOnly(owner.date || owner.payment_date || owner.entry_date),
    ...(Object.hasOwn(owner, 'cheque_transaction_date') ? { cheque_transaction_date: owner.cheque_transaction_date } : {}),
  };
}

/**
 * All cheque views read clearance metadata from the same ledger mirror. The
 * source's accounting/application date remains unchanged. Callers resolve an
 * identity with existing source links rather than guessing from display IDs.
 */
export async function attachChequeDates(rows, db, identityOf) {
  const lookups = new Map();
  const identities = new Map();
  for (const row of rows) {
    if (!hasCheque(row)) continue;
    const preloaded = Object.hasOwn(row, 'cheque_transaction_date');
    const preloadedDate = chequeDateOnly(row.cheque_transaction_date);
    row.cheque_apply_date = chequeDateOnly(row.cheque_apply_date || row.date || row.payment_date || row.entry_date);
    row.cheque_transaction_date = null;
    const identity = identityOf(row);
    if (!identity?.useOwnerMetadata && String(row.cheque_status || '').trim().toUpperCase() !== 'CLEARED') continue;
    if (preloaded && !identity?.useOwnerMetadata) {
      row.cheque_transaction_date = preloadedDate;
      continue;
    }
    if (!identity) continue;
    const siteId = Number(identity.siteId);
    const ledgerId = Number(identity.ledgerId) || null;
    const direct = ['cashflow_entry', 'cash_flow_entry', 'cash_flow_entries', 'personal_ledger', 'site_ledger'].includes(identity.sourceModule);
    const lookup = {
      site_id: siteId,
      ledger_id: ledgerId || (direct ? Number(identity.sourceId) : null),
      source_module: ledgerId || direct ? null : identity.sourceModule,
      source_id: ledgerId || direct ? null : Number(identity.sourceId),
    };
    if (!Number.isInteger(siteId) || siteId <= 0 || (!lookup.ledger_id && (!lookup.source_module || !lookup.source_id))) continue;
    const key = JSON.stringify(lookup);
    lookups.set(key, { ...lookup, lookup_key: key });
    identities.set(row, { key, useOwnerMetadata: Boolean(identity.useOwnerMetadata) });
  }
  if (!lookups.size) return rows;
  const legacyFallback = [...lookups.values()].some(lookup => lookup.source_module === 'plot_commissions')
    ? ` OR (requested.ledger_id IS NULL AND requested.source_module = 'plot_commissions'
        AND cfe.source_module = 'day_book' AND cfe.source_id IN (
          SELECT d.id FROM day_book d WHERE d.commission_id = requested.source_id AND d.site_id = requested.site_id
        ) AND NOT EXISTS (SELECT 1 FROM cash_flow_entries native
          WHERE native.site_id = requested.site_id AND native.source_module = 'plot_commissions' AND native.source_id = requested.source_id))` : '';
  const { rows: dates } = await db.query(
    `SELECT requested.lookup_key, cfe.cheque_status, cfe.cheque_no,
            TO_CHAR(cfe.date, 'YYYY-MM-DD') AS cheque_apply_date,
            TO_CHAR(cfe.cheque_transaction_date, 'YYYY-MM-DD') AS cheque_transaction_date
       FROM jsonb_to_recordset($1::jsonb) AS requested(
         lookup_key text, site_id int, ledger_id int, source_module text, source_id int
       )
       JOIN cash_flow_entries cfe ON cfe.site_id = requested.site_id
        AND ((requested.ledger_id IS NOT NULL AND cfe.id = requested.ledger_id)
          OR (requested.ledger_id IS NULL AND cfe.source_module = requested.source_module AND cfe.source_id = requested.source_id)${legacyFallback})`,
    [JSON.stringify([...lookups.values()])]
  );
  const byKey = new Map(dates.map((row) => [row.lookup_key, row]));
  for (const [row, { key, useOwnerMetadata }] of identities) {
    const owner = byKey.get(key);
    if (useOwnerMetadata && owner) {
      row.cheque_status = owner.cheque_status;
      row.cheque_no = owner.cheque_no;
      row.cheque_apply_date = chequeDateOnly(owner.cheque_apply_date);
    }
    row.cheque_transaction_date = String(row.cheque_status || '').trim().toUpperCase() === 'CLEARED'
      ? chequeDateOnly(owner?.cheque_transaction_date) : null;
  }
  return rows;
}
