import crypto from 'crypto';
import * as XLSX from '@e965/xlsx';

export const BANK_STATEMENT_PARSER_VERSION = 'bank-statement-v3';

const HEADER_ALIASES = {
  source_serial: ['sr no', 'sr number', 'serial no', 'serial number', 's no', 'sequence', 'no'],
  transaction_date: ['transaction date', 'txn date', 'txn posted date', 'tran date', 'date', 'posting date', 'bank date'],
  value_date: ['value date', 'valued date'],
  narration: ['narration', 'description', 'description narration', 'particulars', 'transaction details', 'transaction remarks', 'remarks', 'details'],
  transaction_reference: ['transaction id', 'transaction reference', 'txn id', 'utr', 'reference', 'reference no', 'ref no'],
  cheque_reference: ['cheque no', 'cheque number', 'chq no', 'chq number', 'instrument no', 'instrument number', 'cheque reference no', 'reference number'],
  debit: ['debit', 'debit amount', 'withdrawal', 'withdrawal amount', 'dr amount', 'amount debited'],
  credit: ['credit', 'credit amount', 'deposit', 'deposit amount', 'cr amount', 'amount credited'],
  balance: ['balance', 'balance inr', 'closing balance', 'available balance', 'available balance inr'],
  account_suffix: ['account suffix', 'account last 4', 'account last four', 'account no', 'account number', 'a c no', 'account'],
  branch: ['branch', 'branch name'],
};

export class BankStatementParseError extends Error {
  constructor(message, code = 'INVALID_STATEMENT') {
    super(message);
    this.name = 'BankStatementParseError';
    this.code = code;
    this.statusCode = 422;
  }
}

export const normalizeText = (value) => String(value ?? '')
  .normalize('NFKC')
  .replace(/[\u200B-\u200D\uFEFF]/g, '')
  .replace(/\s+/g, ' ')
  .trim();

const normalizeHeader = (value) => normalizeText(value)
  .toLocaleLowerCase('en-IN')
  .replace(/[^a-z0-9]+/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

const aliasLookup = new Map(
  Object.entries(HEADER_ALIASES).flatMap(([field, aliases]) => aliases.map((alias) => [normalizeHeader(alias), field]))
);
const compactAliasLookup = new Map(
  Object.entries(HEADER_ALIASES).flatMap(([field, aliases]) => aliases.map((alias) => [normalizeHeader(alias).replace(/\s+/g, ''), field]))
);

const REQUIRED_BANK_STATEMENT_FIELDS = [
  'transaction_reference', 'transaction_date', 'value_date', 'narration', 'cheque_reference',
  'debit', 'credit', 'balance', 'account_suffix', 'branch',
];

const cellString = (value) => {
  if (value == null) return '';
  if (value instanceof Date) return value.toISOString();
  return normalizeText(value);
};

function excelDateToIso(value) {
  if (value instanceof Date && !Number.isNaN(value.valueOf())) return value.toISOString().slice(0, 10);
  if (typeof value === 'number' && Number.isFinite(value)) {
    const parsed = XLSX.SSF.parse_date_code(value);
    if (parsed?.y && parsed?.m && parsed?.d) {
      return `${String(parsed.y).padStart(4, '0')}-${String(parsed.m).padStart(2, '0')}-${String(parsed.d).padStart(2, '0')}`;
    }
  }

  const raw = normalizeText(value);
  if (!raw) return null;
  const iso = raw.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  // Many Indian bank exports append a time to DD/MM/YYYY, and some exports
  // store only a handful of rows as Excel serials. Parse both forms without
  // handing an ambiguous DD/MM value to the JavaScript Date constructor.
  const indian = raw.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})(?:$|[ T])/);
  let year;
  let month;
  let day;
  if (iso) [, year, month, day] = iso;
  else if (indian) {
    [, day, month, year] = indian;
    if (year.length === 2) year = String(Number(year) + (Number(year) >= 70 ? 1900 : 2000));
  } else {
    const parsed = new Date(raw);
    if (Number.isNaN(parsed.valueOf())) return null;
    year = parsed.getUTCFullYear();
    month = parsed.getUTCMonth() + 1;
    day = parsed.getUTCDate();
  }
  const candidate = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  const check = new Date(`${candidate}T00:00:00Z`);
  return Number.isNaN(check.valueOf()) || check.toISOString().slice(0, 10) !== candidate ? null : candidate;
}

export function decimalToMinorUnits(value) {
  if (value == null || value === '') return null;
  let text = String(value).trim().replace(/[₹,$\s]/g, '').replace(/,/g, '');
  if (!text) return null;
  const negativeByBrackets = /^\(.*\)$/.test(text);
  text = text.replace(/[()]/g, '');
  if (!/^[+-]?\d+(?:\.\d+)?$/.test(text)) return null;
  const negative = negativeByBrackets || text.startsWith('-');
  const unsigned = text.replace(/^[+-]/, '');
  const [whole, decimal = ''] = unsigned.split('.');
  const rounded = `${decimal}00`.slice(0, 3);
  let minor = (BigInt(whole || '0') * 100n) + BigInt(rounded.slice(0, 2));
  if (Number(rounded[2] || 0) >= 5) minor += 1n;
  return negative ? -minor : minor;
}

export const minorUnitsToDecimal = (minor) => {
  if (minor == null) return null;
  const value = typeof minor === 'bigint' ? minor : BigInt(minor);
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  return `${negative ? '-' : ''}${absolute / 100n}.${String(absolute % 100n).padStart(2, '0')}`;
};

function mapHeaderRow(row) {
  const duplicates = new Set();
  const seenHeaders = new Set();
  const mapped = {};
  const original = {};
  row.forEach((value, index) => {
    const header = normalizeHeader(value);
    if (!header) return;
    if (seenHeaders.has(header)) duplicates.add(cellString(value));
    seenHeaders.add(header);
    // Bank-generated Excel files sometimes split words at a visual wrap
    // boundary (for example "Transactio n Date" and "Balance(IN R)"). A
    // compact alias comparison repairs only known headers; arbitrary columns
    // are never guessed into accounting fields.
    const field = aliasLookup.get(header) || compactAliasLookup.get(header.replace(/\s+/g, ''));
    if (field && mapped[field] == null) {
      mapped[field] = index;
      original[field] = cellString(value);
    }
  });
  return { mapped, original, duplicates: [...duplicates] };
}

function headerScore(mapped) {
  let score = 0;
  if (mapped.transaction_date != null) score += 5;
  if (mapped.narration != null || mapped.transaction_reference != null || mapped.cheque_reference != null) score += 4;
  if (mapped.debit != null || mapped.credit != null) score += 5;
  score += Object.keys(mapped).length;
  return score;
}

function detectStatementSheet(workbook) {
  const preferredName = workbook.SheetNames.find((name) => normalizeHeader(name) === 'bank statement');
  if (preferredName) {
    const sheet = workbook.Sheets[preferredName];
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: null, blankrows: false });
    const candidate = mapHeaderRow(rows[0] || []);
    if (candidate.duplicates.length) throw new BankStatementParseError(`Duplicate headers are not allowed: ${candidate.duplicates.join(', ')}`, 'DUPLICATE_HEADERS');
    const score = headerScore(candidate.mapped);
    if (candidate.mapped.transaction_date == null || (candidate.mapped.debit == null && candidate.mapped.credit == null)) {
      throw new BankStatementParseError('Bank_Statement row 1 must contain a transaction date and debit or credit columns.', 'HEADERS_NOT_FOUND');
    }
    return { sheetName: preferredName, rows, headerIndex: 0, score, ...candidate };
  }
  let best = null;
  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: null, blankrows: false });
    for (let headerIndex = 0; headerIndex < Math.min(rows.length, 20); headerIndex += 1) {
      const candidate = mapHeaderRow(rows[headerIndex] || []);
      const score = headerScore(candidate.mapped);
      if (!best || score > best.score) best = { sheetName, rows, headerIndex, score, ...candidate };
    }
  }
  if (!best || best.score < 14 || best.mapped.transaction_date == null
      || (best.mapped.narration == null && best.mapped.transaction_reference == null && best.mapped.cheque_reference == null)
      || (best.mapped.debit == null && best.mapped.credit == null)) {
    throw new BankStatementParseError('No statement sheet contains date, narration/reference, and debit or credit columns.', 'HEADERS_NOT_FOUND');
  }
  if (best.duplicates.length) {
    throw new BankStatementParseError(`Duplicate headers are not allowed: ${best.duplicates.join(', ')}`, 'DUPLICATE_HEADERS');
  }
  return best;
}

function isBlankRow(row) {
  return !row.some((cell) => cell != null && normalizeText(cell) !== '');
}

function rawRowObject(headerRow, row) {
  const output = {};
  headerRow.forEach((header, index) => {
    const key = cellString(header) || `Column ${index + 1}`;
    output[key] = row[index] instanceof Date ? row[index].toISOString() : row[index];
  });
  return output;
}

function normalizedRow(row, mapped) {
  const value = (field) => (mapped[field] == null ? null : row[mapped[field]]);
  const debitMinor = decimalToMinorUnits(value('debit'));
  const creditMinor = decimalToMinorUnits(value('credit'));
  const balanceMinor = decimalToMinorUnits(value('balance'));
  return {
    source_serial: cellString(value('source_serial')),
    transaction_date: excelDateToIso(value('transaction_date')),
    value_date: excelDateToIso(value('value_date')),
    narration: cellString(value('narration')),
    transaction_reference: cellString(value('transaction_reference')),
    cheque_reference: cellString(value('cheque_reference')),
    debit: minorUnitsToDecimal(debitMinor),
    credit: minorUnitsToDecimal(creditMinor),
    balance: minorUnitsToDecimal(balanceMinor),
    debit_minor: debitMinor?.toString() ?? null,
    credit_minor: creditMinor?.toString() ?? null,
    balance_minor: balanceMinor?.toString() ?? null,
    account_suffix: cellString(value('account_suffix')),
    branch: cellString(value('branch')),
  };
}

function validateRow(row) {
  const errors = [];
  if (!row.transaction_date) errors.push('Transaction date is missing or invalid');
  if (!row.narration && !row.transaction_reference && !row.cheque_reference) errors.push('Narration or reference is required');
  const debit = row.debit_minor == null ? null : BigInt(row.debit_minor);
  const credit = row.credit_minor == null ? null : BigInt(row.credit_minor);
  const positiveDebit = debit != null && debit > 0n;
  const positiveCredit = credit != null && credit > 0n;
  if (!positiveDebit && !positiveCredit) errors.push('A positive debit or credit amount is required');
  if (positiveDebit && positiveCredit) errors.push('A row cannot contain both debit and credit amounts');
  return errors;
}

export function parseBankStatement(buffer, filename = 'statement.xlsx') {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new BankStatementParseError('The uploaded statement is empty.', 'EMPTY_FILE');
  let workbook;
  try {
    // Keep Excel dates as serials. `cellDates: true` creates timezone-shifted
    // Date objects (midnight IST became the previous UTC day in this app).
    workbook = XLSX.read(buffer, { type: 'buffer', cellDates: false, dense: false });
  } catch (error) {
    throw new BankStatementParseError(`The workbook is corrupt or password-protected: ${error.message}`, 'CORRUPT_WORKBOOK');
  }
  if (!workbook.SheetNames?.length) throw new BankStatementParseError('The workbook contains no sheets.', 'EMPTY_WORKBOOK');

  const detected = detectStatementSheet(workbook);
  const headerRow = detected.rows[detected.headerIndex] || [];
  const titleText = detected.rows
    .slice(0, detected.headerIndex)
    .flatMap((row) => row.map(cellString))
    .filter(Boolean)
    .join(' ');
  const accountNumbers = titleText.match(/\b\d{8,20}\b/g) || [];
  const statementAccountNumber = accountNumbers.sort((a, b) => b.length - a.length)[0] || '';
  const strictNamedSheet = normalizeHeader(detected.sheetName) === 'bank statement';
  const missingMappings = strictNamedSheet
    ? REQUIRED_BANK_STATEMENT_FIELDS.filter((field) => detected.mapped[field] == null)
    : [];
  const rawHeaders = headerRow.map(cellString);
  const parsedRows = [];
  for (let index = detected.headerIndex + 1; index < detected.rows.length; index += 1) {
    const sourceRow = detected.rows[index] || [];
    if (isBlankRow(sourceRow)) continue;
    const normalized = normalizedRow(sourceRow, detected.mapped);
    const raw = rawRowObject(headerRow, sourceRow);
    const errors = validateRow(normalized);
    if (missingMappings.length) {
      errors.unshift(`Header mapping missing for: ${missingMappings.join(', ')}. Raw headers: ${rawHeaders.join(' | ')}`);
    }
    const fingerprintInput = [
      normalized.transaction_date,
      normalized.value_date,
      normalized.source_serial,
      normalized.transaction_reference,
      normalized.cheque_reference,
      normalized.narration,
      normalized.debit,
      normalized.credit,
      normalized.balance,
      normalized.account_suffix,
    ].map((item) => normalizeText(item).toLocaleLowerCase('en-IN')).join('|');
    parsedRows.push({
      rowNumber: index + 1,
      raw,
      normalized,
      errors,
      fingerprint: crypto.createHash('sha256').update(fingerprintInput).digest('hex'),
    });
  }

  if (!parsedRows.length) throw new BankStatementParseError('The detected statement sheet contains no transactions.', 'EMPTY_STATEMENT');
  const fingerprintCounts = new Map();
  parsedRows.forEach((row) => fingerprintCounts.set(row.fingerprint, (fingerprintCounts.get(row.fingerprint) || 0) + 1));
  parsedRows.forEach((row) => {
    if (fingerprintCounts.get(row.fingerprint) > 1) row.errors.push('Duplicate transaction row in this statement');
  });
  const comparableDates = parsedRows
    .map((row) => row.normalized.transaction_date)
    .filter(Boolean);
  let ascending = true;
  let descending = true;
  for (let index = 1; index < comparableDates.length; index += 1) {
    if (comparableDates[index] < comparableDates[index - 1]) ascending = false;
    if (comparableDates[index] > comparableDates[index - 1]) descending = false;
  }
  const statementOrder = ascending ? 'ASC' : descending ? 'DESC' : 'MIXED';
  const chainRows = statementOrder === 'DESC' ? [...parsedRows].reverse() : parsedRows;
  const balanceMismatchRows = [];
  let previousBalance = null;
  let balanceChecks = 0;
  if (statementOrder !== 'MIXED') {
    for (const row of chainRows) {
      const normalized = row.normalized;
      const balance = normalized.balance_minor == null ? null : BigInt(normalized.balance_minor);
      const debit = normalized.debit_minor == null ? 0n : BigInt(normalized.debit_minor);
      const credit = normalized.credit_minor == null ? 0n : BigInt(normalized.credit_minor);
      if (balance == null) continue;
      if (previousBalance != null) {
        balanceChecks += 1;
        if (previousBalance + credit - debit !== balance) balanceMismatchRows.push(row.rowNumber);
      }
      previousBalance = balance;
    }
  }

  const datedRows = parsedRows.filter((row) => row.normalized.transaction_date);
  const transactionDates = datedRows.map((row) => row.normalized.transaction_date).sort();
  return {
    filename,
    fileHash: crypto.createHash('sha256').update(buffer).digest('hex'),
    parserVersion: BANK_STATEMENT_PARSER_VERSION,
    sheetName: detected.sheetName,
    mappedHeaders: { ...detected.original, _raw_headers: rawHeaders, _column_indexes: detected.mapped },
    metadata: {
      title: titleText,
      statement_account_number: statementAccountNumber,
      statement_account_suffix: statementAccountNumber.slice(-4),
      date_from: transactionDates[0] || null,
      date_to: transactionDates.at(-1) || null,
    },
    integrity: {
      statement_order: statementOrder,
      balance_checks: balanceChecks,
      balance_mismatch_count: balanceMismatchRows.length,
      balance_mismatch_rows: balanceMismatchRows,
    },
    rows: parsedRows,
    parseErrorCount: parsedRows.filter((row) => row.errors.length > 0).length,
  };
}
