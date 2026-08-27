import 'dotenv/config';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import * as XLSX from '@e965/xlsx';
import pool from '../config/db.js';
import { decimalToMinorUnits, minorUnitsToDecimal, normalizeText } from '../services/bankStatementParser.service.js';

const args = Object.fromEntries(process.argv.slice(2).map((arg) => {
  const [key, ...rest] = arg.replace(/^--/, '').split('=');
  return [key, rest.length ? rest.join('=') : true];
}));

const headerAliases = {
  seed_key: ['seed key', 'case id', 'erp id', 'pending cheque id', 'id'],
  cheque_no: ['cheque no', 'cheque number', 'chq no', 'instrument no'],
  amount: ['amount', 'cheque amount', 'receipt amount'],
  date: ['receipt date', 'date', 'cheque date', 'booking date'],
  direction: ['direction', 'debit credit', 'dr cr', 'transaction type'],
  customer: ['customer', 'customer name', 'party name', 'name'],
  aliases: ['aliases', 'customer aliases', 'alias'],
  payer_names: ['payer names', 'payer', 'related payer', 'company name'],
  booking_reference: ['booking reference', 'booking ref', 'booking no'],
  plot_reference: ['plot reference', 'plot no', 'plot number'],
  account_suffix: ['account suffix', 'bank account suffix', 'account no'],
  bank_name: ['bank name', 'bank'],
  narration: ['narration', 'description', 'remarks', 'particular'],
};

const normalizeHeader = (value) => normalizeText(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const headerLookup = new Map(Object.entries(headerAliases).flatMap(([field, values]) => values.map((value) => [value, field])));

function cellDate(value) {
  if (value instanceof Date && !Number.isNaN(value.valueOf())) return value.toISOString().slice(0, 10);
  if (typeof value === 'number') {
    const parsed = XLSX.SSF.parse_date_code(value);
    if (parsed?.y) return `${parsed.y}-${String(parsed.m).padStart(2, '0')}-${String(parsed.d).padStart(2, '0')}`;
  }
  const text = normalizeText(value);
  const match = text.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})$/);
  if (match) {
    let year = match[3];
    if (year.length === 2) year = String(Number(year) + 2000);
    return `${year}-${match[2].padStart(2, '0')}-${match[1].padStart(2, '0')}`;
  }
  const parsed = new Date(text);
  return Number.isNaN(parsed.valueOf()) ? null : parsed.toISOString().slice(0, 10);
}

function splitValues(value) {
  return normalizeText(value).split(/[|,;]/).map((item) => normalizeText(item)).filter(Boolean);
}

function readFixture(filename) {
  const workbook = XLSX.read(fs.readFileSync(filename), { type: 'buffer', cellDates: true });
  const sheetName = workbook.SheetNames.find((name) => normalizeHeader(name) === 'erp pending cheques');
  if (!sheetName) throw new Error('The fixture must contain an ERP_Pending_Cheques sheet.');
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, raw: true, defval: null, blankrows: false });
  if (rows.length < 2) throw new Error('ERP_Pending_Cheques is empty.');
  const mapped = {};
  rows[0].forEach((header, index) => {
    const field = headerLookup.get(normalizeHeader(header));
    if (field && mapped[field] == null) mapped[field] = index;
  });
  if (mapped.cheque_no == null || mapped.amount == null || mapped.date == null) {
    throw new Error('ERP_Pending_Cheques requires cheque number, amount, and receipt date columns.');
  }
  const value = (row, field) => mapped[field] == null ? null : row[mapped[field]];
  return rows.slice(1).filter((row) => row.some((item) => normalizeText(item))).map((row, index) => {
    const chequeNo = normalizeText(value(row, 'cheque_no'));
    const amountMinor = decimalToMinorUnits(value(row, 'amount'));
    const date = cellDate(value(row, 'date'));
    if (!chequeNo || !amountMinor || amountMinor <= 0n || !date) throw new Error(`Invalid pending cheque fixture row ${index + 2}.`);
    const naturalKey = normalizeText(value(row, 'seed_key')) || [chequeNo, minorUnitsToDecimal(amountMinor), date].join('|');
    return {
      seedKey: `BANK_RECON_DEMO:${crypto.createHash('sha256').update(naturalKey).digest('hex').slice(0, 24)}`,
      chequeNo,
      amount: minorUnitsToDecimal(amountMinor),
      date,
      direction: /credit|cr|incoming|receipt/i.test(normalizeText(value(row, 'direction'))) ? 'CREDIT' : 'DEBIT',
      customer: normalizeText(value(row, 'customer')) || 'Bank reconciliation demo party',
      aliases: splitValues(value(row, 'aliases')),
      payerNames: splitValues(value(row, 'payer_names')),
      bookingReference: normalizeText(value(row, 'booking_reference')) || null,
      plotReference: normalizeText(value(row, 'plot_reference')) || null,
      accountSuffix: normalizeText(value(row, 'account_suffix')).replace(/[^0-9A-Za-z]/g, '').slice(-8) || null,
      bankName: normalizeText(value(row, 'bank_name')) || null,
      narration: normalizeText(value(row, 'narration')) || `Pending cheque ${chequeNo}`,
    };
  });
}

async function seed() {
  if (process.env.NODE_ENV === 'production') throw new Error('Bank reconciliation demo seed is disabled in production.');
  const fixture = path.resolve(String(args.fixture || 'Bank_Reconciliation_AI_Demo_10_Cases.xlsx'));
  const organizationId = Number.parseInt(args.organization, 10);
  const siteId = Number.parseInt(args.site, 10);
  if (!Number.isInteger(organizationId) || !Number.isInteger(siteId) || args['confirm-demo'] !== true) {
    throw new Error('Usage: npm run seed:bank-reconciliation -- --fixture=/path/file.xlsx --organization=<id> --site=<id> --confirm-demo');
  }
  const fixtureRows = readFixture(fixture);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const siteResult = await client.query(
      `SELECT id, name, organization_id FROM sites WHERE id = $1 AND organization_id = $2 FOR UPDATE`,
      [siteId, organizationId]
    );
    const site = siteResult.rows[0];
    if (!site || !/(demo|test)/i.test(site.name)) throw new Error('Refusing to seed: the selected site name must explicitly contain DEMO or TEST.');
    const userResult = await client.query(
      `SELECT id FROM users WHERE organization_id = $1 AND role IN ('admin', 'super_admin') AND is_active = TRUE ORDER BY id LIMIT 1`,
      [organizationId]
    );
    const actorId = userResult.rows[0]?.id;
    if (!actorId) throw new Error('The demo organisation needs an active admin user.');
    let created = 0;
    let skipped = 0;
    for (const row of fixtureRows) {
      const existing = await client.query(
        `SELECT entity_entry_id FROM bank_reconciliation_candidate_metadata
          WHERE organization_id = $1 AND site_id = $2 AND seed_key = $3`,
        [organizationId, siteId, row.seedKey]
      );
      if (existing.rows[0]) { skipped += 1; continue; }
      const date = new Date(`${row.date}T00:00:00Z`);
      let month = await client.query(
        `SELECT id FROM cash_flow_months
          WHERE site_id = $1 AND month = $2 AND year = $3 AND ledger_name = 'Bank reconciliation demo'
          ORDER BY id LIMIT 1 FOR UPDATE`,
        [siteId, date.getUTCMonth() + 1, date.getUTCFullYear()]
      );
      if (!month.rows[0]) {
        month = await client.query(
          `INSERT INTO cash_flow_months (site_id, month, year, opening_balance, notes, ledger_name, ledger_type, created_by)
           VALUES ($1,$2,$3,0,'Idempotent bank reconciliation acceptance fixture','Bank reconciliation demo','site',$4)
           RETURNING id`,
          [siteId, date.getUTCMonth() + 1, date.getUTCFullYear(), actorId]
        );
      }
      const entry = await client.query(
        `INSERT INTO cash_flow_entries (
           cash_flow_month_id, site_id, date, particular, debit, credit, remarks,
           created_by, cash_type, status, approved_by, approved_at, is_firm_transaction,
           cheque_status, cheque_no, to_name
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'cheque','approved',$8,NOW(),FALSE,'PENDING',$9,$10)
         RETURNING id`,
        [month.rows[0].id, siteId, row.date, row.narration,
          row.direction === 'DEBIT' ? row.amount : '0.00', row.direction === 'CREDIT' ? row.amount : '0.00',
          row.seedKey, actorId, row.chequeNo, row.customer]
      );
      const entryId = entry.rows[0].id;
      await client.query(
        `INSERT INTO bank_reconciliation_candidate_metadata (
           organization_id, site_id, entity_source, entity_entry_id, payer_names,
           booking_reference, plot_reference, account_suffix, bank_name, seed_key, created_by
         ) VALUES ($1,$2,'cash_flow_entry',$3,$4,$5,$6,$7,$8,$9,$10)`,
        [organizationId, siteId, entryId, JSON.stringify(row.payerNames), row.bookingReference,
          row.plotReference, row.accountSuffix, row.bankName, row.seedKey, actorId]
      );
      const aliases = [...new Set([...row.aliases, ...row.payerNames].map(normalizeText).filter(Boolean))];
      for (const alias of aliases) {
        await client.query(
          `INSERT INTO bank_reconciliation_aliases (
             organization_id, site_id, entity_source, entity_entry_id, alias_value, normalized_alias, created_by
           ) VALUES ($1,$2,'cash_flow_entry',$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
          [organizationId, siteId, entryId, alias, normalizeHeader(alias), actorId]
        );
      }
      created += 1;
    }
    await client.query('COMMIT');
    console.log(`Bank reconciliation demo seeded for ${site.name}: ${created} created, ${skipped} already present.`);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

seed()
  .catch((error) => {
    console.error('Bank reconciliation demo seed failed:', error.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
