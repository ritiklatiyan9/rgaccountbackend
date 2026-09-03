import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import pool from '../config/db.js';
import { parseBankStatement } from '../services/bankStatementParser.service.js';

const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(name);
  return index === -1 ? null : args[index + 1] || null;
};
const file = option('--file');
const siteId = Number.parseInt(option('--site-id'), 10);

if (!file || !Number.isInteger(siteId) || siteId <= 0) {
  console.error('Usage: node src/scripts/importBankDaybookStatementView.mjs --site-id <id> --file <statement.xls>');
  process.exitCode = 1;
} else {
  const buffer = await fs.readFile(file);
  const parsed = parseBankStatement(buffer, path.basename(file));
  const isTransaction = (item) => {
    const row = item.normalized;
    const debit = BigInt(row.debit_minor || '0');
    const credit = BigInt(row.credit_minor || '0');
    return debit > 0n || credit > 0n;
  };
  // Keep every monetary row exactly once, including legitimate duplicate
  // bank transactions. Parser duplicate flags are validation hints, not a
  // reason to remove a row from a statement presentation.
  const transactions = parsed.rows.filter(isTransaction);
  if (!transactions.length) throw new Error('No monetary rows were found in the statement.');
  const viewRows = transactions.map((item, index) => ({
    position: index + 1,
    sheet_row: item.rowNumber,
    statement_serial: item.normalized.source_serial || '',
    transaction_date: item.normalized.transaction_date,
    value_date: item.normalized.value_date,
    narration: item.normalized.narration || '',
    transaction_reference: item.normalized.transaction_reference || '',
    cheque_reference: item.normalized.cheque_reference || '',
    debit: item.normalized.debit || '0.00',
    credit: item.normalized.credit || '0.00',
    running_balance: item.normalized.balance,
    raw_row: item.raw,
  }));

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const siteResult = await client.query(
      'SELECT id, organization_id FROM sites WHERE id = $1 LIMIT 1',
      [siteId],
    );
    const site = siteResult.rows[0];
    if (!site) throw new Error(`Site ${siteId} was not found.`);
    const existingResult = await client.query(
      `SELECT id FROM bank_daybook_statement_views
        WHERE organization_id = $1 AND site_id = $2 AND source_hash = $3
        LIMIT 1`,
      [site.organization_id, site.id, parsed.fileHash],
    );
    let viewId = existingResult.rows[0]?.id;
    if (viewId) {
      await client.query('DELETE FROM bank_daybook_statement_view_rows WHERE view_id = $1', [viewId]);
      await client.query(
        `UPDATE bank_daybook_statement_views
            SET account_number = $2, source_filename = $3, statement_sheet = $4,
                parser_version = $5, date_from = $6, date_to = $7, is_active = TRUE,
                updated_at = NOW()
          WHERE id = $1`,
        [viewId, parsed.metadata.statement_account_number || null, path.basename(file), parsed.sheetName,
          parsed.parserVersion, parsed.metadata.date_from, parsed.metadata.date_to],
      );
    } else {
      const inserted = await client.query(
        `INSERT INTO bank_daybook_statement_views (
           organization_id, site_id, account_number, source_filename, source_hash,
           statement_sheet, parser_version, date_from, date_to, is_active
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,TRUE)
         RETURNING id`,
        [site.organization_id, site.id, parsed.metadata.statement_account_number || null, path.basename(file),
          parsed.fileHash, parsed.sheetName, parsed.parserVersion, parsed.metadata.date_from, parsed.metadata.date_to],
      );
      viewId = inserted.rows[0].id;
    }
    await client.query(
      'UPDATE bank_daybook_statement_views SET is_active = FALSE, updated_at = NOW() WHERE site_id = $1 AND id <> $2 AND is_active',
      [site.id, viewId],
    );
    await client.query(
      `INSERT INTO bank_daybook_statement_view_rows (
         view_id, position, sheet_row, statement_serial, transaction_date, value_date,
         narration, transaction_reference, cheque_reference, debit, credit, running_balance, raw_row
       )
       SELECT $1,
              (row_data->>'position')::integer,
              NULLIF(row_data->>'sheet_row', '')::integer,
              NULLIF(row_data->>'statement_serial', ''),
              NULLIF(row_data->>'transaction_date', '')::date,
              NULLIF(row_data->>'value_date', '')::date,
              NULLIF(row_data->>'narration', ''),
              NULLIF(row_data->>'transaction_reference', ''),
              NULLIF(row_data->>'cheque_reference', ''),
              COALESCE(NULLIF(row_data->>'debit', '')::numeric, 0),
              COALESCE(NULLIF(row_data->>'credit', '')::numeric, 0),
              NULLIF(row_data->>'running_balance', '')::numeric,
              COALESCE(row_data->'raw_row', '{}'::jsonb)
         FROM jsonb_array_elements($2::jsonb) AS row_data`,
      [viewId, JSON.stringify(viewRows)],
    );
    await client.query('COMMIT');
    const lastBalance = viewRows.at(-1)?.running_balance || 'n/a';
    console.log(JSON.stringify({ view_id: Number(viewId), site_id: siteId, rows: viewRows.length, closing_balance: lastBalance }, null, 2));
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}
