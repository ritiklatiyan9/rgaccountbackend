import crypto from 'crypto';

export const BANK_DAYBOOK_MATCHER_VERSION = 'bank-daybook-v1';

const STOP_WORDS = new Set([
  'bank', 'limited', 'ltd', 'payment', 'transfer', 'transaction', 'from', 'to',
  'the', 'and', 'for', 'via', 'account', 'india', 'indian', 'amount', 'rupee',
  'upi', 'imps', 'neft', 'rtgs', 'inft', 'clg', 'cheque', 'chq', 'ref', 'txn',
]);

const normalizeText = (value) => String(value ?? '')
  .normalize('NFKC')
  .toLocaleUpperCase('en-IN')
  .replace(/[^A-Z0-9]+/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

const textTokens = (value) => new Set(
  normalizeText(value)
    .split(' ')
    .filter((token) => token.length >= 3 && !STOP_WORDS.has(token.toLocaleLowerCase('en-IN')))
);

const references = (value) => new Set(
  normalizeText(value)
    .split(' ')
    .filter((token) => token.length >= 4 && token.length <= 40 && /\d/.test(token))
);

const intersection = (left, right) => [...left].filter((value) => right.has(value));

const dateDistance = (left, right) => {
  if (!left || !right) return Number.POSITIVE_INFINITY;
  return Math.abs((Date.parse(`${left}T00:00:00Z`) - Date.parse(`${right}T00:00:00Z`)) / 86400000);
};

const statementFacts = (row) => {
  const normalized = row.normalized || {};
  const debit = normalized.debit_minor == null ? 0n : BigInt(normalized.debit_minor);
  const credit = normalized.credit_minor == null ? 0n : BigInt(normalized.credit_minor);
  return {
    row_number: Number(row.rowNumber),
    source_serial: normalized.source_serial || '',
    date: normalized.transaction_date,
    value_date: normalized.value_date,
    direction: debit > 0n ? 'DEBIT' : 'CREDIT',
    amount_minor: (debit > 0n ? debit : credit).toString(),
    debit: normalized.debit,
    credit: normalized.credit,
    balance: normalized.balance,
    narration: normalized.narration || '',
    transaction_reference: normalized.transaction_reference || '',
    cheque_reference: normalized.cheque_reference === '-' ? '' : (normalized.cheque_reference || ''),
    source_note: String(row.raw?.['Column 9'] || ''),
    errors: Array.isArray(row.errors) ? row.errors : [],
  };
};

const exactKey = (item) => `${item.date}|${item.direction}|${item.amount_minor}`;
const amountKey = (item) => `${item.direction}|${item.amount_minor}`;

const candidateText = (candidate) => [
  candidate.particular,
  candidate.remarks,
  candidate.cheque_no,
  candidate.entity_name,
  candidate.linked_detail,
].filter(Boolean).join(' ');

function pairSignals(row, candidate) {
  const statementText = [row.narration, row.transaction_reference, row.cheque_reference].filter(Boolean).join(' ');
  const erpText = candidateText(candidate);
  const rowReferences = references(statementText);
  const candidateReferences = references(erpText);
  const sharedReferences = intersection(rowReferences, candidateReferences);
  const rowTokens = textTokens(statementText);
  const candidateTokens = textTokens(erpText);
  const sharedTokens = intersection(rowTokens, candidateTokens);
  const containment = Math.min(1, sharedTokens.length / Math.max(1, Math.min(rowTokens.size, candidateTokens.size)));
  const cheque = normalizeText(row.cheque_reference);
  const candidateCheque = normalizeText(candidate.cheque_no);
  const chequeMatch = Boolean(cheque && candidateCheque && cheque === candidateCheque);
  const strongReference = chequeMatch || sharedReferences.length > 0;
  const textScore = Math.min(1, (strongReference ? 0.72 : 0) + (containment * 0.28));
  return {
    strongReference,
    textScore,
    sharedReferences: sharedReferences.slice(0, 4),
    sharedTokens: sharedTokens.slice(0, 6),
    signals: [
      'Exact transaction date',
      'Exact debit/credit direction',
      'Exact amount to the paise',
      ...(chequeMatch ? ['Exact cheque reference'] : []),
      ...(sharedReferences.length ? [`Shared bank reference: ${sharedReferences.slice(0, 2).join(', ')}`] : []),
      ...(sharedTokens.length ? [`Shared narration terms: ${sharedTokens.slice(0, 4).join(', ')}`] : []),
    ],
  };
}

function candidateDto(candidate, score = null, exactData = true) {
  return {
    entry_key: candidate.entry_key,
    ledger_id: candidate.ledger_id,
    date: candidate.date,
    direction: candidate.direction,
    amount: candidate.amount,
    amount_minor: candidate.amount_minor,
    particular: candidate.particular || '',
    remarks: candidate.remarks || '',
    cheque_no: candidate.cheque_no || '',
    entity_name: candidate.entity_name || '',
    linked_detail: candidate.linked_detail || '',
    source_key: candidate.source_key,
    source_id: candidate.source_id == null ? null : Number(candidate.source_id),
    bank_account_id: candidate.bank_account_id == null ? null : Number(candidate.bank_account_id),
    bank_account_name: candidate.bank_account_name || '',
    exact_data: exactData,
    score: score == null ? null : Number(score.toFixed(4)),
  };
}

function rowDto(row, patch = {}) {
  return {
    ...row,
    state: 'UNMATCHED',
    confidence: 0,
    candidate: null,
    alternatives: [],
    signals: [],
    warnings: [],
    ...patch,
  };
}

/**
 * Deterministic, one-to-one matching. Amount, direction, and transaction date
 * are hard constraints for every orderable pair. Narration and references are
 * used only to resolve duplicate candidates; they can never excuse a data
 * mismatch.
 */
export function reconcileBankDaybookRows(parsedRows, candidates) {
  const statementRows = parsedRows.map(statementFacts);
  const output = new Map();
  const rowsByKey = new Map();
  const candidatesByKey = new Map();
  const candidatesByAmount = new Map();
  const automaticallyUsed = new Set();

  for (const candidate of candidates) {
    const key = exactKey(candidate);
    if (!candidatesByKey.has(key)) candidatesByKey.set(key, []);
    candidatesByKey.get(key).push(candidate);
    const aKey = amountKey(candidate);
    if (!candidatesByAmount.has(aKey)) candidatesByAmount.set(aKey, []);
    candidatesByAmount.get(aKey).push(candidate);
  }

  for (const row of statementRows) {
    if (row.errors.length) {
      output.set(row.row_number, rowDto(row, {
        state: 'BLOCKED',
        warnings: [...row.errors],
      }));
      continue;
    }
    const key = exactKey(row);
    if (!rowsByKey.has(key)) rowsByKey.set(key, []);
    rowsByKey.get(key).push(row);
  }

  for (const [key, groupedRows] of rowsByKey) {
    const groupedCandidates = candidatesByKey.get(key) || [];
    const availableRows = new Set(groupedRows.map((row) => row.row_number));
    const availableCandidates = new Set(groupedCandidates.map((candidate) => candidate.entry_key));
    const pairs = groupedRows.flatMap((row) => groupedCandidates.map((candidate) => ({
      row,
      candidate,
      ...pairSignals(row, candidate),
    })));

    // Strong identifiers resolve duplicate amount/date groups. Require a
    // margin on both sides unless an exact cheque/reference is shared.
    const rankedPairs = [...pairs].sort((left, right) => (
      Number(right.strongReference) - Number(left.strongReference)
      || right.textScore - left.textScore
      || left.row.row_number - right.row.row_number
      || left.candidate.entry_key.localeCompare(right.candidate.entry_key)
    ));
    for (const pair of rankedPairs) {
      if (!availableRows.has(pair.row.row_number) || !availableCandidates.has(pair.candidate.entry_key)) continue;
      if (!pair.strongReference && pair.textScore < 0.55) continue;
      const rowCompetitors = rankedPairs.filter((item) => (
        item.row.row_number === pair.row.row_number
        && item.candidate.entry_key !== pair.candidate.entry_key
        && availableCandidates.has(item.candidate.entry_key)
      ));
      const candidateCompetitors = rankedPairs.filter((item) => (
        item.candidate.entry_key === pair.candidate.entry_key
        && item.row.row_number !== pair.row.row_number
        && availableRows.has(item.row.row_number)
      ));
      const rowMargin = pair.textScore - (rowCompetitors[0]?.textScore || 0);
      const candidateMargin = pair.textScore - (candidateCompetitors[0]?.textScore || 0);
      if (!pair.strongReference && (rowMargin < 0.12 || candidateMargin < 0.12)) continue;
      if (pair.strongReference && (rowMargin < 0.01 || candidateMargin < 0.01)) continue;

      availableRows.delete(pair.row.row_number);
      availableCandidates.delete(pair.candidate.entry_key);
      automaticallyUsed.add(pair.candidate.entry_key);
      output.set(pair.row.row_number, rowDto(pair.row, {
        state: 'MATCHED',
        confidence: pair.strongReference ? 0.99 : 0.96,
        candidate: candidateDto(pair.candidate, pair.textScore),
        alternatives: rankedPairs
          .filter((item) => item.row.row_number === pair.row.row_number)
          .slice(0, 6)
          .map((item) => candidateDto(item.candidate, item.textScore)),
        signals: pair.signals,
      }));
    }

    // A single remaining row and candidate is unambiguous on exact accounting
    // data even when the ERP narration is sparse.
    if (availableRows.size === 1 && availableCandidates.size === 1) {
      const rowNumber = [...availableRows][0];
      const entryKey = [...availableCandidates][0];
      const row = groupedRows.find((item) => item.row_number === rowNumber);
      const candidate = groupedCandidates.find((item) => item.entry_key === entryKey);
      const scored = pairSignals(row, candidate);
      automaticallyUsed.add(entryKey);
      output.set(rowNumber, rowDto(row, {
        state: 'MATCHED',
        confidence: 0.94,
        candidate: candidateDto(candidate, scored.textScore),
        alternatives: [candidateDto(candidate, scored.textScore)],
        signals: scored.signals,
      }));
      availableRows.clear();
      availableCandidates.clear();
    }

    for (const rowNumber of availableRows) {
      const row = groupedRows.find((item) => item.row_number === rowNumber);
      const alternatives = groupedCandidates
        .map((candidate) => ({ candidate, ...pairSignals(row, candidate) }))
        .sort((left, right) => (
          Number(right.strongReference) - Number(left.strongReference)
          || right.textScore - left.textScore
          || left.candidate.entry_key.localeCompare(right.candidate.entry_key)
        ))
        .slice(0, 8);
      if (alternatives.length) {
        output.set(rowNumber, rowDto(row, {
          state: 'REVIEW',
          confidence: Math.min(0.89, 0.55 + (alternatives[0].textScore * 0.3)),
          candidate: candidateDto(alternatives[0].candidate, alternatives[0].textScore),
          alternatives: alternatives.map((item) => candidateDto(item.candidate, item.textScore)),
          signals: alternatives[0].signals,
          warnings: ['More than one ERP entry has the same date, direction, and amount. Choose the exact row before applying.'],
        }));
        continue;
      }

      const nearby = (candidatesByAmount.get(amountKey(row)) || [])
        .map((candidate) => ({ candidate, days: dateDistance(row.date, candidate.date), ...pairSignals(row, candidate) }))
        .filter((item) => item.days <= 7)
        .sort((left, right) => left.days - right.days || right.textScore - left.textScore)
        .slice(0, 6);
      output.set(rowNumber, rowDto(row, nearby.length ? {
        state: 'DATA_MISMATCH',
        candidate: candidateDto(nearby[0].candidate, nearby[0].textScore, false),
        alternatives: nearby.map((item) => candidateDto(item.candidate, item.textScore, false)),
        warnings: [`No ERP row has the same transaction date. Nearest same-amount candidate is ${nearby[0].days} day${nearby[0].days === 1 ? '' : 's'} away.`],
      } : {
        state: 'UNMATCHED',
        warnings: ['No ERP entry has the same transaction date, debit/credit direction, and amount.'],
      }));
    }
  }

  const rows = statementRows.map((row) => output.get(row.row_number));
  const counts = (state) => rows.filter((row) => row.state === state).length;
  return {
    rows,
    summary: {
      statement_rows: rows.length,
      database_rows_in_scope: candidates.filter((candidate) => candidate.in_statement_period !== false).length,
      matched: counts('MATCHED'),
      review: counts('REVIEW'),
      data_mismatch: counts('DATA_MISMATCH'),
      unmatched: counts('UNMATCHED'),
      blocked: counts('BLOCKED'),
      unassigned_database_rows: candidates.filter((candidate) => (
        candidate.in_statement_period !== false && !automaticallyUsed.has(candidate.entry_key)
      )).length,
    },
  };
}

export async function loadBankDaybookCandidates(db, {
  siteId,
  scope = 'all',
  dateFrom,
  dateTo,
  toleranceDays = 7,
}) {
  const numericScope = /^\d+$/.test(String(scope)) ? Number(scope) : null;
  const result = await db.query(
    `SELECT
       le.id::text AS ledger_id,
       CONCAT(le.source_key, ':', COALESCE(le.source_id::text, SPLIT_PART(le.id, ':', 1))) AS entry_key,
       le.source_key, le.source_id,
       TO_CHAR(le.entry_date, 'YYYY-MM-DD') AS date,
       CASE
         WHEN GREATEST(le.debit, 0) + GREATEST(-le.credit, 0) > 0 THEN 'DEBIT'
         ELSE 'CREDIT'
       END AS direction,
       TO_CHAR(
         GREATEST(
           GREATEST(le.debit, 0) + GREATEST(-le.credit, 0),
           GREATEST(le.credit, 0) + GREATEST(-le.debit, 0)
         ),
         'FM999999999999990.00'
       ) AS amount,
       ROUND(
         GREATEST(
           GREATEST(le.debit, 0) + GREATEST(-le.credit, 0),
           GREATEST(le.credit, 0) + GREATEST(-le.debit, 0)
         ) * 100
       )::bigint::text AS amount_minor,
       le.particular, le.remarks, le.cheque_no, le.entity_name, le.linked_detail,
       le.bank_account_id, le.bank_account_name, le.created_at,
       dbo.position AS local_position,
       dgo.position AS global_position,
       (le.entry_date BETWEEN $3::date AND $4::date) AS in_statement_period
     FROM ledger_entries le
     LEFT JOIN daybook_entry_order dbo
       ON dbo.site_id = le.site_id
      AND dbo.entry_date = le.entry_date
      AND dbo.entry_key = CONCAT(le.source_key, ':', COALESCE(le.source_id::text, SPLIT_PART(le.id, ':', 1)))
     LEFT JOIN daybook_global_order dgo
       ON dgo.site_id = le.site_id
      AND dgo.entry_key = CONCAT(le.source_key, ':', COALESCE(le.source_id::text, SPLIT_PART(le.id, ':', 1)))
     WHERE le.site_id = $1
       AND le.bucket <> 'cash'
       AND le.entry_date BETWEEN ($3::date - $5::int) AND ($4::date + $5::int)
       AND (
         $2::text = 'all'
         OR ($2::text = 'unmapped' AND le.bank_account_id IS NULL)
         OR ($6::int IS NOT NULL AND le.bank_account_id = $6::int)
       )
     ORDER BY le.entry_date, le.created_at, le.id`,
    [siteId, String(scope), dateFrom, dateTo, toleranceDays, numericScope]
  );
  return result.rows.map((row) => ({
    ...row,
    source_id: row.source_id == null ? null : Number(row.source_id),
    bank_account_id: row.bank_account_id == null ? null : Number(row.bank_account_id),
    local_position: row.local_position == null ? null : Number(row.local_position),
    global_position: row.global_position == null ? null : Number(row.global_position),
    in_statement_period: row.in_statement_period === true,
  }));
}

export function candidateSnapshotHash(candidates) {
  const input = [...candidates]
    .sort((left, right) => left.entry_key.localeCompare(right.entry_key) || left.ledger_id.localeCompare(right.ledger_id))
    .map((candidate) => [
      candidate.entry_key,
      candidate.ledger_id,
      candidate.date,
      candidate.direction,
      candidate.amount_minor,
      candidate.bank_account_id ?? '',
      candidate.local_position ?? '',
      candidate.global_position ?? '',
      normalizeText(candidateText(candidate)),
    ].join('|'))
    .join('\n');
  return crypto.createHash('sha256').update(input).digest('hex');
}

export function exactStatementCandidatePair(parsedRow, candidate) {
  const row = statementFacts(parsedRow);
  return row.errors.length === 0
    && row.date === candidate.date
    && row.direction === candidate.direction
    && row.amount_minor === candidate.amount_minor;
}

export function canonicalMatchedKeys(matches, statementOrder) {
  return [...matches].sort((left, right) => {
    const dateOrder = right.date.localeCompare(left.date);
    if (dateOrder) return dateOrder;
    return statementOrder === 'ASC'
      ? right.row_number - left.row_number
      : left.row_number - right.row_number;
  });
}
