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
  || [row.payment_mode, row.payment_type, row.cash_type].some((mode) => ['CHEQUE', 'CHECK'].includes(String(mode || '').trim().toUpperCase()));

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
    if (String(row.cheque_status || '').trim().toUpperCase() !== 'CLEARED') continue;
    if (preloaded) {
      row.cheque_transaction_date = preloadedDate;
      continue;
    }
    const identity = identityOf(row);
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
    identities.set(row, key);
  }
  if (!lookups.size) return rows;
  const { rows: dates } = await db.query(
    `SELECT requested.lookup_key,
            TO_CHAR(cfe.cheque_transaction_date, 'YYYY-MM-DD') AS cheque_transaction_date
       FROM jsonb_to_recordset($1::jsonb) AS requested(
         lookup_key text, site_id int, ledger_id int, source_module text, source_id int
       )
       JOIN cash_flow_entries cfe ON cfe.site_id = requested.site_id
        AND ((requested.ledger_id IS NOT NULL AND cfe.id = requested.ledger_id)
          OR (requested.ledger_id IS NULL AND cfe.source_module = requested.source_module AND cfe.source_id = requested.source_id))`,
    [JSON.stringify([...lookups.values()])]
  );
  const byKey = new Map(dates.map((row) => [row.lookup_key, chequeDateOnly(row.cheque_transaction_date)]));
  for (const [row, key] of identities) row.cheque_transaction_date = byKey.get(key) || null;
  return rows;
}
