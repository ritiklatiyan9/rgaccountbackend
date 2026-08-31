import pool from '../config/db.js';
import { parseBankStatement } from '../services/bankStatementParser.service.js';
import { writeAuditLog } from '../services/auditLog.service.js';
import { transactionDto } from './bankReconciliation.controller.js';

const WORKFLOW = 'TRANSACTION';
const MODULE_KEYS = new Set([
  'farmer', 'land_profit', 'cashflow', 'firm', 'expense',
  'daybook', 'plot', 'plot_commission', 'misc_income',
]);

const numericId = (value, label = 'id') => {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    const error = new Error(`A valid ${label} is required.`);
    error.statusCode = 400;
    error.code = 'INVALID_ID';
    throw error;
  }
  return parsed;
};

const fail = (message, statusCode, code) => {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  throw error;
};

const sendError = (res, error) => {
  const status = Number(error.statusCode) || (error.code === '23505' ? 409 : 500);
  if (status >= 500) console.error('[transaction-reconciliation]', error);
  return res.status(status).json({
    message: status >= 500 && !error.statusCode
      ? 'Transaction reconciliation could not be completed.'
      : error.message,
    code: error.code || 'TRANSACTION_RECONCILIATION_ERROR',
  });
};

const dateOnly = (value) => {
  if (!value) return null;
  if (value instanceof Date && !Number.isNaN(value.valueOf())) {
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
  }
  return String(value).slice(0, 10);
};

async function assertSiteAccess(db, user, requestedSiteId) {
  const siteId = numericId(requestedSiteId, 'site id');
  const result = await db.query(
    `SELECT s.id, s.name, s.organization_id,
            CASE WHEN $3 = 'sub_admin' THEN EXISTS (
              SELECT 1 FROM user_sites us WHERE us.site_id = s.id AND us.user_id = $2
            ) ELSE TRUE END AS assigned
       FROM sites s
      WHERE s.id = $1 AND s.organization_id = $4`,
    [siteId, user.id, user.role, Number(user.organization_id) || 1]
  );
  const site = result.rows[0];
  if (!site || !site.assigned) fail('The selected site is outside your authorised workspace.', 403, 'SITE_ACCESS_DENIED');
  return site;
}

const uploadDto = (upload) => ({
  id: Number(upload.id),
  site_id: Number(upload.site_id),
  site_name: upload.site_name,
  workflow: upload.workflow,
  original_filename: upload.original_filename,
  file_size: Number(upload.file_size),
  file_hash: upload.file_hash,
  parser_version: upload.parser_version,
  statement_sheet: upload.statement_sheet,
  mapped_headers: upload.mapped_headers || {},
  processing_state: upload.processing_state,
  row_count: Number(upload.row_count),
  parse_error_count: Number(upload.parse_error_count),
  created_at: upload.created_at,
  updated_at: upload.updated_at,
});

const linkedTransactionDto = (row) => ({
  ...transactionDto(row),
  reconciliation: row.posting_id ? {
    id: Number(row.posting_id),
    direction: row.posting_direction,
    module_key: row.posting_module_key,
    source_entry_id: Number(row.posting_source_entry_id),
    entry_date: dateOnly(row.posting_entry_date),
    entry_amount: String(row.posting_entry_amount),
    posted_by: row.posted_by_name || '',
    posted_at: row.posted_at,
  } : null,
});

async function loadUpload(db, user, uploadId) {
  const id = numericId(uploadId, 'upload id');
  const uploadResult = await db.query(
    `SELECT u.*, s.name AS site_name
       FROM bank_statement_uploads u
       JOIN sites s ON s.id = u.site_id
      WHERE u.id = $1 AND u.organization_id = $2 AND u.workflow = $3`,
    [id, Number(user.organization_id) || 1, WORKFLOW]
  );
  const upload = uploadResult.rows[0];
  if (!upload) fail('Transaction statement upload not found.', 404, 'UPLOAD_NOT_FOUND');
  await assertSiteAccess(db, user, upload.site_id);
  const transactions = await db.query(
    `SELECT t.*,
            l.id AS posting_id,
            l.direction AS posting_direction,
            l.module_key AS posting_module_key,
            l.source_entry_id AS posting_source_entry_id,
            l.entry_date AS posting_entry_date,
            l.entry_amount AS posting_entry_amount,
            l.created_at AS posted_at,
            u.name AS posted_by_name
       FROM bank_statement_transactions t
       LEFT JOIN bank_transaction_module_links l ON l.bank_transaction_id = t.id
       LEFT JOIN users u ON u.id = l.posted_by
      WHERE t.upload_id = $1
      ORDER BY t.row_number`,
    [id]
  );
  return { upload, transactions: transactions.rows.map(linkedTransactionDto) };
}

export async function getLatestTransactionUpload(req, res) {
  try {
    const site = await assertSiteAccess(pool, req.user, req.query.site_id ?? req.query.siteId);
    const result = await pool.query(
      `SELECT id FROM bank_statement_uploads
        WHERE organization_id = $1 AND site_id = $2 AND workflow = $3
        ORDER BY created_at DESC, id DESC LIMIT 1`,
      [site.organization_id, site.id, WORKFLOW]
    );
    if (!result.rows[0]) return res.json({ upload: null, transactions: [] });
    const loaded = await loadUpload(pool, req.user, result.rows[0].id);
    return res.json({ upload: uploadDto(loaded.upload), transactions: loaded.transactions });
  } catch (error) {
    return sendError(res, error);
  }
}

export async function getTransactionUpload(req, res) {
  try {
    const loaded = await loadUpload(pool, req.user, req.params.uploadId);
    return res.json({ upload: uploadDto(loaded.upload), transactions: loaded.transactions });
  } catch (error) {
    return sendError(res, error);
  }
}

export async function createTransactionUpload(req, res) {
  let client;
  try {
    if (!req.file) fail('Choose an .xlsx, .xls, or .csv bank statement.', 400, 'FILE_REQUIRED');
    const site = await assertSiteAccess(pool, req.user, req.body.site_id ?? req.body.siteId);
    const parsed = parseBankStatement(req.file.buffer, req.file.originalname);
    client = await pool.connect();
    await client.query('BEGIN');
    const existingResult = await client.query(
      `SELECT u.*, s.name AS site_name
         FROM bank_statement_uploads u
         JOIN sites s ON s.id = u.site_id
        WHERE u.organization_id = $1 AND u.site_id = $2 AND u.file_hash = $3 AND u.workflow = $4
        FOR UPDATE OF u`,
      [site.organization_id, site.id, parsed.fileHash, WORKFLOW]
    );
    const existing = existingResult.rows[0];
    if (existing?.parser_version === parsed.parserVersion) {
      await client.query('COMMIT');
      const loaded = await loadUpload(pool, req.user, existing.id);
      return res.status(200).json({ upload: uploadDto(existing), transactions: loaded.transactions, duplicate: true });
    }

    let upload;
    let reparsed = false;
    if (existing) {
      const linked = await client.query(
        'SELECT 1 FROM bank_transaction_module_links WHERE upload_id = $1 LIMIT 1',
        [existing.id]
      );
      if (linked.rowCount) {
        fail('This statement already contains reconciled transactions and cannot be reparsed. Upload a corrected file instead.', 409, 'RECONCILED_UPLOAD_REPARSE_BLOCKED');
      }
      await client.query('DELETE FROM bank_statement_transactions WHERE upload_id = $1', [existing.id]);
      const updated = await client.query(
        `UPDATE bank_statement_uploads
            SET uploaded_by=$2, original_filename=$3, content_type=$4, file_size=$5,
                parser_version=$6, statement_sheet=$7, mapped_headers=$8, row_count=$9,
                parse_error_count=$10, processing_state='PARSED', updated_at=NOW()
          WHERE id=$1 RETURNING *`,
        [existing.id, req.user.id, req.file.originalname, req.file.mimetype, req.file.size,
          parsed.parserVersion, parsed.sheetName, JSON.stringify(parsed.mappedHeaders),
          parsed.rows.length, parsed.parseErrorCount]
      );
      upload = updated.rows[0];
      reparsed = true;
    } else {
      const inserted = await client.query(
        `INSERT INTO bank_statement_uploads (
           organization_id, site_id, uploaded_by, original_filename, content_type,
           file_size, file_hash, parser_version, statement_sheet, mapped_headers,
           row_count, parse_error_count, workflow
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         RETURNING *`,
        [site.organization_id, site.id, req.user.id, req.file.originalname, req.file.mimetype,
          req.file.size, parsed.fileHash, parsed.parserVersion, parsed.sheetName,
          JSON.stringify(parsed.mappedHeaders), parsed.rows.length, parsed.parseErrorCount, WORKFLOW]
      );
      upload = inserted.rows[0];
    }

    for (const row of parsed.rows) {
      const normalized = row.normalized;
      await client.query(
        `INSERT INTO bank_statement_transactions (
           upload_id, organization_id, site_id, row_number, transaction_date, value_date,
           transaction_reference, cheque_reference, narration, debit, credit, balance,
           account_suffix, branch, raw_row, normalized_row, row_fingerprint, parse_errors
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
        [upload.id, site.organization_id, site.id, row.rowNumber, normalized.transaction_date,
          normalized.value_date, normalized.transaction_reference, normalized.cheque_reference,
          normalized.narration, normalized.debit, normalized.credit, normalized.balance,
          normalized.account_suffix || null, normalized.branch || null, JSON.stringify(row.raw),
          JSON.stringify(normalized), row.fingerprint, JSON.stringify(row.errors)]
      );
    }
    await writeAuditLog({
      organizationId: site.organization_id,
      siteId: site.id,
      userId: req.user.id,
      action: reparsed ? 'UPDATE' : 'CREATE',
      eventType: 'RECONCILIATION',
      module: 'transaction_reconciliation',
      entityType: 'bank_statement_upload',
      entityId: upload.id,
      description: `${reparsed ? 'Reparsed' : 'Uploaded'} bank statement for transaction reconciliation`,
      newValues: { filename: req.file.originalname, rows: parsed.rows.length, parse_errors: parsed.parseErrorCount },
      metadata: { workflow: WORKFLOW, file_hash: parsed.fileHash },
    }, client);
    await client.query('COMMIT');
    upload.site_name = site.name;
    const loaded = await loadUpload(pool, req.user, upload.id);
    return res.status(reparsed ? 200 : 201).json({
      upload: uploadDto(upload), transactions: loaded.transactions, duplicate: false, reparsed,
    });
  } catch (error) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    return sendError(res, error);
  } finally {
    client?.release();
  }
}

async function loadSourceEntry(db, moduleKey, entryId) {
  const queries = {
    farmer: `SELECT p.id, f.site_id, p.date AS entry_date, ABS(p.amount) AS entry_amount,
                    CASE WHEN p.amount > 0 THEN 'debit' ELSE 'credit' END AS entry_direction,
                    p.created_by
               FROM farmer_payments p JOIN farmers f ON f.id = p.farmer_id WHERE p.id = $1`,
    land_profit: `SELECT p.id, p.site_id, p.date AS entry_date, ABS(p.amount) AS entry_amount,
                         'credit' AS entry_direction, p.created_by
                    FROM land_deal_payments p WHERE p.id = $1`,
    cashflow: `SELECT e.id, e.site_id, e.date AS entry_date,
                      CASE WHEN e.debit > 0 THEN e.debit ELSE e.credit END AS entry_amount,
                      CASE WHEN e.debit > 0 THEN 'debit' ELSE 'credit' END AS entry_direction,
                      e.created_by
                 FROM cash_flow_entries e WHERE e.id = $1`,
    firm: `SELECT e.id, e.site_id, e.date AS entry_date,
                  CASE WHEN e.debit > 0 THEN e.debit ELSE e.credit END AS entry_amount,
                  CASE WHEN e.debit > 0 THEN 'debit' ELSE 'credit' END AS entry_direction,
                  e.created_by
             FROM firm_transactions e WHERE e.id = $1`,
    expense: `SELECT e.id, e.site_id, e.date AS entry_date,
                     CASE WHEN e.debit > 0 THEN e.debit ELSE e.credit END AS entry_amount,
                     CASE WHEN e.debit > 0 THEN 'debit' ELSE 'credit' END AS entry_direction,
                     e.created_by
                FROM expenses e WHERE e.id = $1`,
    daybook: `SELECT e.id, e.site_id, e.date AS entry_date,
                     CASE WHEN e.debit > 0 THEN e.debit ELSE e.credit END AS entry_amount,
                     CASE WHEN e.debit > 0 THEN 'debit' ELSE 'credit' END AS entry_direction,
                     e.created_by
                FROM day_book e WHERE e.id = $1`,
    plot: `SELECT e.id, e.site_id, e.date AS entry_date, ABS(e.amount) AS entry_amount,
                  CASE WHEN e.amount < 0 THEN 'debit' ELSE 'credit' END AS entry_direction,
                  e.created_by
             FROM plot_payments e WHERE e.id = $1`,
    plot_commission: `SELECT e.id, e.site_id, e.date AS entry_date, ABS(e.amount) AS entry_amount,
                             CASE WHEN e.amount > 0 THEN 'debit' ELSE 'credit' END AS entry_direction,
                             e.created_by
                        FROM plot_commission_payments e WHERE e.id = $1`,
    misc_income: `SELECT e.id, e.site_id, e.date AS entry_date, ABS(e.amount) AS entry_amount,
                         LOWER(e.direction) AS entry_direction, e.created_by
                    FROM misc_income_entries e WHERE e.id = $1`,
  };
  const result = await db.query(queries[moduleKey], [entryId]);
  return result.rows[0];
}

const bankRowAmount = (row) => {
  const debit = Math.abs(Number(row.debit) || 0);
  const credit = Math.abs(Number(row.credit) || 0);
  if ((debit > 0) === (credit > 0)) {
    fail('The active statement row must contain exactly one debit or credit amount.', 422, 'AMBIGUOUS_BANK_AMOUNT');
  }
  return debit || credit;
};

export async function linkTransactionPosting(req, res) {
  const client = await pool.connect();
  try {
    const transactionId = numericId(req.params.transactionId, 'bank transaction id');
    const sourceEntryId = numericId(req.body.source_entry_id ?? req.body.sourceEntryId, 'source entry id');
    const direction = String(req.body.direction || '').trim().toLowerCase();
    const moduleKey = String(req.body.module_key ?? req.body.moduleKey ?? '').trim();
    if (!['credit', 'debit'].includes(direction)) fail('Choose Credit or Debit before selecting a module.', 400, 'INVALID_DIRECTION');
    if (!MODULE_KEYS.has(moduleKey)) fail('Choose a supported accounting module.', 400, 'INVALID_MODULE');

    await client.query('BEGIN');
    const transactionResult = await client.query(
      `SELECT t.*, up.workflow
         FROM bank_statement_transactions t
         JOIN bank_statement_uploads up ON up.id = t.upload_id
        WHERE t.id = $1 AND t.organization_id = $2
        FOR UPDATE OF t`,
      [transactionId, Number(req.user.organization_id) || 1]
    );
    const transaction = transactionResult.rows[0];
    if (!transaction || transaction.workflow !== WORKFLOW) fail('Statement transaction not found.', 404, 'TRANSACTION_NOT_FOUND');
    await assertSiteAccess(client, req.user, transaction.site_id);
    if (Array.isArray(transaction.parse_errors) && transaction.parse_errors.length) {
      fail('This statement row has parsing errors. Upload a corrected statement before posting it.', 422, 'ROW_PARSE_ERRORS');
    }
    if (!transaction.transaction_date) fail('The statement row has no transaction date.', 422, 'ROW_DATE_REQUIRED');

    const currentResult = await client.query(
      `SELECT t.id
         FROM bank_statement_transactions t
         LEFT JOIN bank_transaction_module_links l ON l.bank_transaction_id = t.id
        WHERE t.upload_id = $1 AND l.id IS NULL
        ORDER BY t.row_number, t.id
        LIMIT 1
        FOR UPDATE OF t`,
      [transaction.upload_id]
    );
    if (Number(currentResult.rows[0]?.id) !== transactionId) {
      fail('Only the first unresolved statement row can be posted. Refresh the queue and continue in order.', 409, 'ROW_NOT_ACTIVE');
    }
    const existingLink = await client.query(
      'SELECT id FROM bank_transaction_module_links WHERE bank_transaction_id = $1',
      [transactionId]
    );
    if (existingLink.rowCount) fail('This statement row was already reconciled.', 409, 'ALREADY_RECONCILED');

    const source = await loadSourceEntry(client, moduleKey, sourceEntryId);
    if (!source) fail('The newly-created module entry could not be verified.', 409, 'SOURCE_ENTRY_NOT_FOUND');
    if (Number(source.site_id) !== Number(transaction.site_id)) fail('The module entry belongs to a different site.', 409, 'SOURCE_SITE_MISMATCH');
    if (Number(source.created_by) !== Number(req.user.id)) fail('Only the entry created in this reconciliation session can be linked.', 403, 'SOURCE_CREATOR_MISMATCH');
    const expectedAmount = bankRowAmount(transaction);
    if (Math.abs(Number(source.entry_amount) - expectedAmount) > 0.005) fail('The module entry amount does not match the bank transaction.', 409, 'SOURCE_AMOUNT_MISMATCH');
    if (String(source.entry_direction).toLowerCase() !== direction) fail('The module entry direction does not match the selected Credit/Debit action.', 409, 'SOURCE_DIRECTION_MISMATCH');
    if (dateOnly(source.entry_date) !== dateOnly(transaction.transaction_date)) fail('The module entry date does not match the bank transaction date.', 409, 'SOURCE_DATE_MISMATCH');

    const inserted = await client.query(
      `INSERT INTO bank_transaction_module_links (
         organization_id, site_id, upload_id, bank_transaction_id, direction,
         module_key, source_entry_id, entry_date, entry_amount, entry_snapshot, posted_by
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING *`,
      [transaction.organization_id, transaction.site_id, transaction.upload_id, transaction.id,
        direction, moduleKey, sourceEntryId, dateOnly(source.entry_date), Number(source.entry_amount),
        JSON.stringify({
          narration: transaction.narration || '',
          transaction_reference: transaction.transaction_reference || '',
          cheque_reference: transaction.cheque_reference || '',
          row_fingerprint: transaction.row_fingerprint,
        }), req.user.id]
    );
    await client.query(
      `UPDATE bank_statement_uploads up
          SET processing_state = CASE
                WHEN EXISTS (
                  SELECT 1
                    FROM bank_statement_transactions remaining
                    LEFT JOIN bank_transaction_module_links linked
                      ON linked.bank_transaction_id = remaining.id
                   WHERE remaining.upload_id = up.id AND linked.id IS NULL
                ) THEN 'MATCHED'
                ELSE 'CONFIRMED'
              END,
              updated_at = NOW()
        WHERE up.id = $1`,
      [transaction.upload_id]
    );
    await writeAuditLog({
      organizationId: transaction.organization_id,
      siteId: transaction.site_id,
      userId: req.user.id,
      action: 'RECONCILE',
      eventType: 'RECONCILIATION',
      module: 'transaction_reconciliation',
      transactionName: transaction.narration || transaction.transaction_reference || `Statement row ${transaction.row_number}`,
      amount: expectedAmount,
      entityType: moduleKey,
      entityId: sourceEntryId,
      description: `Bank statement row ${transaction.row_number} posted to ${moduleKey}`,
      newValues: { direction, module_key: moduleKey, source_entry_id: sourceEntryId },
      metadata: { upload_id: Number(transaction.upload_id), bank_transaction_id: transactionId, row_fingerprint: transaction.row_fingerprint },
    }, client);
    await client.query('COMMIT');
    return res.status(201).json({
      message: 'Transaction posted and reconciled successfully.',
      reconciliation: {
        id: Number(inserted.rows[0].id), direction, module_key: moduleKey,
        source_entry_id: sourceEntryId, entry_date: dateOnly(source.entry_date),
        entry_amount: String(inserted.rows[0].entry_amount), posted_at: inserted.rows[0].created_at,
      },
    });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    return sendError(res, error);
  } finally {
    client.release();
  }
}
