import pool from '../config/db.js';
import { writeAuditLog } from '../services/auditLog.service.js';
import { parseBankStatement } from '../services/bankStatementParser.service.js';
import {
  AiResolverError,
  CHEQUE_MATCHER_VERSION,
  hasChequeReturnSignal,
  loadPendingChequeCandidates,
  runAiAssistance,
  serializeMatchResult,
} from '../services/chequeMatching.service.js';
import { ChequeStatusError, updateChequeStatusRecord } from '../services/chequeStatus.service.js';

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

export function requireAiMatchMode(value) {
  const mode = String(value || 'AI').trim().toUpperCase();
  if (mode !== 'AI') {
    const error = new Error('Only AI matching is available.');
    error.statusCode = 400;
    error.code = 'INVALID_MATCH_MODE';
    throw error;
  }
  return mode;
}

function sendError(res, error) {
  const status = Number(error.statusCode) || 500;
  if (status >= 500) console.error('[bank-reconciliation]', error);
  return res.status(status).json({
    message: status >= 500 && !error.statusCode ? 'Bank reconciliation could not be completed.' : error.message,
    code: error.code || 'BANK_RECONCILIATION_ERROR',
  });
}

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
  if (!site || !site.assigned) {
    const error = new Error('The selected site is outside your authorised workspace.');
    error.statusCode = 403;
    error.code = 'SITE_ACCESS_DENIED';
    throw error;
  }
  return site;
}

const dateOnlyDto = (value) => {
  if (!value) return null;
  if (value instanceof Date && !Number.isNaN(value.valueOf())) {
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
  }
  const text = String(value);
  return /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : text;
};

export function transactionDto(row) {
  return {
    id: Number(row.id),
    upload_id: Number(row.upload_id),
    row_number: Number(row.row_number),
    transaction_date: dateOnlyDto(row.transaction_date),
    value_date: dateOnlyDto(row.value_date),
    transaction_reference: row.transaction_reference || '',
    cheque_reference: row.cheque_reference || '',
    narration: row.narration || '',
    debit: row.debit == null ? null : String(row.debit),
    credit: row.credit == null ? null : String(row.credit),
    balance: row.balance == null ? null : String(row.balance),
    account_suffix: row.account_suffix || '',
    branch: row.branch || '',
    raw_row: row.raw_row || {},
    normalized_row: row.normalized_row || {},
    row_fingerprint: row.row_fingerprint,
    parse_errors: Array.isArray(row.parse_errors) ? row.parse_errors : [],
  };
}

async function loadUpload(db, user, uploadId, { includeTransactions = true } = {}) {
  const id = numericId(uploadId, 'upload id');
  const result = await db.query(
    `SELECT u.*, s.name AS site_name
       FROM bank_statement_uploads u
       JOIN sites s ON s.id = u.site_id
      WHERE u.id = $1 AND u.organization_id = $2`,
    [id, Number(user.organization_id) || 1]
  );
  const upload = result.rows[0];
  if (!upload) {
    const error = new Error('Bank statement upload not found.');
    error.statusCode = 404;
    error.code = 'UPLOAD_NOT_FOUND';
    throw error;
  }
  await assertSiteAccess(db, user, upload.site_id);
  if (!includeTransactions) return { upload };
  const transactions = await db.query(
    `SELECT * FROM bank_statement_transactions WHERE upload_id = $1 ORDER BY row_number`,
    [id]
  );
  return { upload, transactions: transactions.rows.map(transactionDto) };
}

function uploadDto(upload) {
  return {
    id: Number(upload.id),
    site_id: Number(upload.site_id),
    site_name: upload.site_name,
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
  };
}

function matchSummary(results) {
  return {
    rows: results.length,
    matched: results.filter((item) => item.review_state === 'MATCHED').length,
    review: results.filter((item) => item.review_state !== 'MATCHED').length,
    cleared: results.filter((item) => item.proposed_status === 'CLEARED' && item.review_state === 'MATCHED').length,
    bounced: results.filter((item) => item.proposed_status === 'BOUNCED' && item.review_state === 'MATCHED').length,
    exact: results.filter((item) => item.match_origin === 'EXACT_RULE').length,
    ai: results.filter((item) => item.match_origin === 'AI_SUGGESTION').length,
  };
}

async function persistSuggestions(db, runId, results) {
  const persisted = [];
  for (const result of results) {
    const inserted = await db.query(
      `INSERT INTO bank_reconciliation_suggestions (
         run_id, bank_transaction_id, candidate_source, candidate_entry_id,
         proposed_status, match_origin, confidence, review_state, matched_signals,
         conflicting_signals, warnings, alternatives, decision_reason, resolver_metadata
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       RETURNING id`,
      [
        runId,
        result.transaction.id,
        result.candidate?.source || null,
        result.candidate?.entry_id || null,
        result.proposed_status,
        result.match_origin,
        Number(result.confidence) || 0,
        result.review_state,
        JSON.stringify(result.matched_signals || []),
        JSON.stringify(result.conflicting_signals || []),
        JSON.stringify(result.warnings || []),
        JSON.stringify(result.alternatives || []),
        result.decision_reason || null,
        JSON.stringify(result.resolver_metadata || {}),
      ]
    );
    persisted.push({ id: Number(inserted.rows[0].id), ...serializeMatchResult(result) });
  }
  return persisted;
}

function storedSuggestionDto(row) {
  const alternatives = Array.isArray(row.alternatives) ? row.alternatives : [];
  const candidateId = row.candidate_source && row.candidate_entry_id ? `${row.candidate_source}:${row.candidate_entry_id}` : null;
  return {
    id: Number(row.id),
    transaction: transactionDto({ ...row, id: row.transaction_row_id }),
    candidate: alternatives.find((item) => item.candidate_id === candidateId) || (candidateId ? {
      candidate_id: candidateId,
      source: row.candidate_source,
      entry_id: Number(row.candidate_entry_id),
    } : null),
    proposed_status: row.proposed_status,
    match_origin: row.match_origin,
    confidence: Number(row.confidence),
    review_state: row.review_state,
    matched_signals: row.matched_signals || [],
    conflicting_signals: row.conflicting_signals || [],
    warnings: row.warnings || [],
    alternatives,
    decision_reason: row.decision_reason,
    resolver_metadata: row.resolver_metadata || {},
    override_reason: row.override_reason,
  };
}

async function loadRun(db, user, runId) {
  const id = numericId(runId, 'run id');
  const runResult = await db.query(
    `SELECT r.*, u.original_filename, u.row_count, u.parse_error_count
       FROM bank_reconciliation_runs r
       JOIN bank_statement_uploads u ON u.id = r.upload_id
      WHERE r.id = $1 AND r.organization_id = $2`,
    [id, Number(user.organization_id) || 1]
  );
  const run = runResult.rows[0];
  if (!run) {
    const error = new Error('Matching run not found.');
    error.statusCode = 404;
    error.code = 'RUN_NOT_FOUND';
    throw error;
  }
  await assertSiteAccess(db, user, run.site_id);
  const suggestions = await db.query(
    `SELECT s.*, t.*,
            s.id AS id, t.id AS transaction_row_id
       FROM bank_reconciliation_suggestions s
       JOIN bank_statement_transactions t ON t.id = s.bank_transaction_id
      WHERE s.run_id = $1
      ORDER BY t.row_number`,
    [id]
  );
  const rows = suggestions.rows.map((row) => storedSuggestionDto({ ...row, id: row.id, upload_id: row.upload_id }));
  return {
    run: {
      id: Number(run.id),
      upload_id: Number(run.upload_id),
      site_id: Number(run.site_id),
      mode: run.mode,
      status: run.status,
      resolver_version: run.resolver_version,
      provider_model: run.provider_model,
      provider_error: run.provider_error,
      created_at: run.created_at,
      completed_at: run.completed_at,
    },
    suggestions: rows,
    summary: matchSummary(rows),
  };
}

export async function getConfiguration(req, res) {
  return res.json({
    ai: {
      available: Boolean(process.env.GROQ_API_KEY),
      provider: 'groq',
      model: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
      fallback_model: process.env.GROQ_FALLBACK_MODEL || 'openai/gpt-oss-120b',
      timeout_ms: Number(process.env.GROQ_TIMEOUT_MS) || 20000,
    },
    upload: { max_bytes: 10 * 1024 * 1024, extensions: ['.xlsx', '.xls', '.csv'] },
  });
}

export async function listPendingCheques(req, res) {
  try {
    const site = await assertSiteAccess(pool, req.user, req.query.site_id ?? req.query.siteId);
    const entries = await loadPendingChequeCandidates(pool, site.organization_id, site.id);
    return res.json({ entries, total: entries.length, site: { id: site.id, name: site.name } });
  } catch (error) {
    return sendError(res, error);
  }
}

export async function createUpload(req, res) {
  let client;
  try {
    if (!req.file) {
      const error = new Error('Choose an .xlsx, .xls, or .csv bank statement.');
      error.statusCode = 400;
      error.code = 'FILE_REQUIRED';
      throw error;
    }
    const site = await assertSiteAccess(pool, req.user, req.body.site_id ?? req.body.siteId);
    const parsed = parseBankStatement(req.file.buffer, req.file.originalname);
    client = await pool.connect();
    await client.query('BEGIN');
    const existing = await client.query(
      `SELECT u.*, s.name AS site_name
         FROM bank_statement_uploads u JOIN sites s ON s.id = u.site_id
        WHERE u.organization_id = $1 AND u.site_id = $2 AND u.file_hash = $3
        FOR UPDATE`,
      [site.organization_id, site.id, parsed.fileHash]
    );
    if (existing.rows[0]?.parser_version === parsed.parserVersion) {
      await client.query('COMMIT');
      const loaded = await loadUpload(pool, req.user, existing.rows[0].id);
      return res.status(200).json({ upload: uploadDto(existing.rows[0]), transactions: loaded.transactions, duplicate: true });
    }
    let upload;
    let reparsed = false;
    if (existing.rows[0]) {
      const confirmed = await client.query('SELECT 1 FROM bank_reconciliation_links WHERE upload_id = $1 LIMIT 1', [existing.rows[0].id]);
      if (confirmed.rowCount) {
        const error = new Error('This saved upload has confirmed reconciliation links and cannot be reparsed. Upload a corrected copy with a different file hash.');
        error.statusCode = 409;
        error.code = 'CONFIRMED_UPLOAD_REPARSE_BLOCKED';
        throw error;
      }
      await client.query('DELETE FROM bank_reconciliation_runs WHERE upload_id = $1', [existing.rows[0].id]);
      await client.query('DELETE FROM bank_statement_transactions WHERE upload_id = $1', [existing.rows[0].id]);
      const updated = await client.query(
        `UPDATE bank_statement_uploads SET uploaded_by=$2,original_filename=$3,content_type=$4,file_size=$5,
           parser_version=$6,statement_sheet=$7,mapped_headers=$8,row_count=$9,parse_error_count=$10,
           processing_state='PARSED',updated_at=NOW() WHERE id=$1 RETURNING *`,
        [existing.rows[0].id, req.user.id, req.file.originalname, req.file.mimetype, req.file.size,
          parsed.parserVersion, parsed.sheetName, JSON.stringify(parsed.mappedHeaders), parsed.rows.length, parsed.parseErrorCount]
      );
      upload = updated.rows[0];
      reparsed = true;
    } else {
      const uploadResult = await client.query(
        `INSERT INTO bank_statement_uploads (
         organization_id, site_id, uploaded_by, original_filename, content_type,
         file_size, file_hash, parser_version, statement_sheet, mapped_headers,
         row_count, parse_error_count
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING *`,
      [site.organization_id, site.id, req.user.id, req.file.originalname, req.file.mimetype,
        req.file.size, parsed.fileHash, parsed.parserVersion, parsed.sheetName,
        JSON.stringify(parsed.mappedHeaders), parsed.rows.length, parsed.parseErrorCount]
      );
      upload = uploadResult.rows[0];
    }
    const transactions = [];
    for (const row of parsed.rows) {
      const normalized = row.normalized;
      const inserted = await client.query(
        `INSERT INTO bank_statement_transactions (
           upload_id, organization_id, site_id, row_number, transaction_date, value_date,
           transaction_reference, cheque_reference, narration, debit, credit, balance,
           account_suffix, branch, raw_row, normalized_row, row_fingerprint, parse_errors
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
         RETURNING *`,
        [upload.id, site.organization_id, site.id, row.rowNumber, normalized.transaction_date,
          normalized.value_date, normalized.transaction_reference, normalized.cheque_reference,
          normalized.narration, normalized.debit, normalized.credit, normalized.balance,
          normalized.account_suffix || null, normalized.branch || null, JSON.stringify(row.raw),
          JSON.stringify(normalized), row.fingerprint, JSON.stringify(row.errors)]
      );
      transactions.push(transactionDto(inserted.rows[0]));
    }
    await client.query('COMMIT');
    upload.site_name = site.name;
    return res.status(reparsed ? 200 : 201).json({ upload: uploadDto(upload), transactions, duplicate: false, reparsed });
  } catch (error) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    return sendError(res, error);
  } finally {
    client?.release();
  }
}

export async function getUpload(req, res) {
  try {
    const loaded = await loadUpload(pool, req.user, req.params.uploadId);
    const latestRunResult = await pool.query(
      `SELECT id FROM bank_reconciliation_runs WHERE upload_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [loaded.upload.id]
    );
    const latestRun = latestRunResult.rows[0] ? await loadRun(pool, req.user, latestRunResult.rows[0].id) : null;
    return res.json({ upload: uploadDto(loaded.upload), transactions: loaded.transactions, latest_run: latestRun });
  } catch (error) {
    return sendError(res, error);
  }
}

export async function matchUpload(req, res) {
  let runId;
  try {
    const mode = requireAiMatchMode(req.body.mode);
    const loaded = await loadUpload(pool, req.user, req.params.uploadId);
    if (Number(loaded.upload.parse_error_count) > 0) {
      const error = new Error('Matching is blocked because the imported statement contains parsing errors. Review the raw Excel headers and row values, then upload a corrected statement.');
      error.statusCode = 422;
      error.code = 'STATEMENT_PARSE_ERRORS';
      throw error;
    }
    const candidates = await loadPendingChequeCandidates(pool, loaded.upload.organization_id, loaded.upload.site_id);
    const created = await pool.query(
      `INSERT INTO bank_reconciliation_runs (
         upload_id, organization_id, site_id, mode, status, resolver_version, created_by
       ) VALUES ($1,$2,$3,$4,'RUNNING',$5,$6) RETURNING id`,
      [loaded.upload.id, loaded.upload.organization_id, loaded.upload.site_id, mode, CHEQUE_MATCHER_VERSION, req.user.id]
    );
    runId = created.rows[0].id;
    const outcome = await runAiAssistance(loaded.transactions, candidates);

    const client = await pool.connect();
    let suggestions;
    try {
      await client.query('BEGIN');
      suggestions = await persistSuggestions(client, runId, outcome.results);
      await client.query(
        `UPDATE bank_reconciliation_runs
            SET status = 'COMPLETED', completed_at = NOW(), provider_request_id = $2,
                provider_model = $3, provider_latency_ms = $4, provider_usage = $5,
                provider_error = $6
          WHERE id = $1`,
        [runId, outcome.provider?.request_id || null, outcome.provider?.model || null,
          outcome.provider?.latency_ms || null, outcome.provider?.usage ? JSON.stringify(outcome.provider.usage) : null,
          outcome.provider?.degraded ? outcome.provider.error_message : null]
      );
      await client.query(`UPDATE bank_statement_uploads SET processing_state = 'MATCHED', updated_at = NOW() WHERE id = $1`, [loaded.upload.id]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    return res.json({
      run: { id: Number(runId), upload_id: Number(loaded.upload.id), mode, status: 'COMPLETED', provider: outcome.provider },
      pending_candidates: candidates.length,
      suggestions,
      summary: matchSummary(outcome.results),
    });
  } catch (error) {
    if (runId) {
      await pool.query(
        `UPDATE bank_reconciliation_runs SET status = 'FAILED', provider_error = $2, completed_at = NOW() WHERE id = $1`,
        [runId, String(error.message || 'Matching failed').slice(0, 1200)]
      ).catch(() => {});
    }
    return sendError(res, error);
  }
}

export async function getRun(req, res) {
  try {
    return res.json(await loadRun(pool, req.user, req.params.runId));
  } catch (error) {
    return sendError(res, error);
  }
}

const transactionAmount = (transaction) => Number(transaction.debit || 0) > 0 ? transaction.debit : transaction.credit;

export async function confirmMatches(req, res) {
  const client = await pool.connect();
  try {
    const runId = numericId(req.body.run_id ?? req.body.runId, 'run id');
    const suggestionIds = [...new Set((req.body.suggestion_ids ?? req.body.suggestionIds ?? []).map((id) => numericId(id, 'suggestion id')))];
    if (!suggestionIds.length) {
      const error = new Error('Select at least one matched row to confirm.');
      error.statusCode = 400;
      error.code = 'NO_ROWS_SELECTED';
      throw error;
    }
    await client.query('BEGIN');
    const runResult = await client.query(
      `SELECT r.*, u.file_hash, u.original_filename
         FROM bank_reconciliation_runs r
         JOIN bank_statement_uploads u ON u.id = r.upload_id
        WHERE r.id = $1 AND r.organization_id = $2
        FOR UPDATE OF r, u`,
      [runId, Number(req.user.organization_id) || 1]
    );
    const run = runResult.rows[0];
    if (!run) {
      const error = new Error('Matching run not found.');
      error.statusCode = 404;
      error.code = 'RUN_NOT_FOUND';
      throw error;
    }
    if (Number(run.upload_id) !== numericId(req.params.uploadId, 'upload id')) {
      const error = new Error('The matching run does not belong to this upload.');
      error.statusCode = 409;
      error.code = 'RUN_UPLOAD_MISMATCH';
      throw error;
    }
    await assertSiteAccess(client, req.user, run.site_id);
    const suggestionResult = await client.query(
      `SELECT s.*, t.transaction_date, t.value_date, t.transaction_reference,
              t.cheque_reference, t.narration, t.debit, t.credit, t.account_suffix,
              t.row_fingerprint, t.parse_errors, t.upload_id
         FROM bank_reconciliation_suggestions s
         JOIN bank_statement_transactions t ON t.id = s.bank_transaction_id
        WHERE s.run_id = $1 AND s.id = ANY($2::bigint[])
        ORDER BY s.id
        FOR UPDATE OF s, t`,
      [runId, suggestionIds]
    );
    if (suggestionResult.rowCount !== suggestionIds.length) {
      const error = new Error('One or more selected suggestions do not belong to this matching run.');
      error.statusCode = 409;
      error.code = 'SUGGESTION_SCOPE_MISMATCH';
      throw error;
    }

    const candidates = await loadPendingChequeCandidates(client, run.organization_id, run.site_id);
    const candidateMap = new Map(candidates.map((candidate) => [candidate.id, candidate]));
    const overrides = new Map((req.body.overrides || []).map((override) => [Number(override.suggestion_id), override]));
    const effects = [];

    for (const suggestion of suggestionResult.rows) {
      if (Array.isArray(suggestion.parse_errors) && suggestion.parse_errors.length) {
        throw new ChequeStatusError(`Statement row ${suggestion.bank_transaction_id} has parse errors.`, 409, 'ROW_BLOCKED');
      }
      const override = overrides.get(Number(suggestion.id));
      let source = suggestion.candidate_source;
      let entryId = Number(suggestion.candidate_entry_id);
      let status = suggestion.proposed_status;
      let origin = suggestion.match_origin;
      let overrideReason = null;
      if (override) {
        overrideReason = String(override.reason || '').trim();
        if (overrideReason.length < 5) throw new ChequeStatusError('Manual override reason must contain at least 5 characters.', 400, 'OVERRIDE_REASON_REQUIRED');
        const candidateId = String(override.candidate_id || '');
        const separator = candidateId.lastIndexOf(':');
        source = candidateId.slice(0, separator);
        entryId = Number.parseInt(candidateId.slice(separator + 1), 10);
        status = String(override.status || '').toUpperCase();
        origin = 'MANUAL_OVERRIDE';
      } else if (suggestion.review_state !== 'MATCHED') {
        throw new ChequeStatusError('Review rows cannot be confirmed without an authorised manual override.', 409, 'REVIEW_NOT_OVERRIDDEN');
      }
      if (!['CLEARED', 'BOUNCED'].includes(status)) throw new ChequeStatusError('Confirmation requires CLEARED or BOUNCED.', 400, 'INVALID_CONFIRM_STATUS');
      const candidate = candidateMap.get(`${source}:${entryId}`);
      if (!candidate) throw new ChequeStatusError('The selected ERP cheque is no longer pending.', 409, 'STALE_CANDIDATE');
      if (Number(transactionAmount(suggestion)).toFixed(2) !== Number(candidate.amount).toFixed(2)) {
        throw new ChequeStatusError('Bank row and ERP cheque amounts no longer match.', 409, 'AMOUNT_MISMATCH');
      }
      const statementDirection = Number(suggestion.debit || 0) > 0 ? 'DEBIT' : 'CREDIT';
      const expectedDirection = status === 'BOUNCED'
        ? (statementDirection === 'DEBIT' ? 'CREDIT' : 'DEBIT')
        : statementDirection;
      if (candidate.direction !== expectedDirection) {
        throw new ChequeStatusError('The selected status conflicts with the bank-row direction.', 409, 'DIRECTION_MISMATCH');
      }
      if (status === 'BOUNCED' && !hasChequeReturnSignal(`${suggestion.narration || ''} ${suggestion.transaction_reference || ''}`)) {
        throw new ChequeStatusError('A bounced update requires an explicit bank-return signal.', 409, 'RETURN_SIGNAL_REQUIRED');
      }
      const statementSuffix = String(suggestion.account_suffix || '').replace(/[^0-9A-Za-z]/g, '').toUpperCase();
      const candidateSuffix = String(candidate.account_suffix || '').replace(/[^0-9A-Za-z]/g, '').toUpperCase();
      if (statementSuffix && candidateSuffix && statementSuffix !== candidateSuffix) {
        throw new ChequeStatusError('The bank-account suffix conflicts with the selected ERP cheque.', 409, 'ACCOUNT_SUFFIX_MISMATCH');
      }
      const duplicate = await client.query(
        `SELECT id FROM bank_reconciliation_links
          WHERE bank_transaction_id = $1
             OR (organization_id = $2 AND site_id = $3 AND candidate_source = $4 AND candidate_entry_id = $5)
             OR (organization_id = $2 AND site_id = $3 AND row_fingerprint = $6)
          LIMIT 1`,
        [suggestion.bank_transaction_id, run.organization_id, run.site_id, source, entryId, suggestion.row_fingerprint]
      );
      if (duplicate.rows[0]) throw new ChequeStatusError('This bank row or ERP cheque was already reconciled.', 409, 'ALREADY_RECONCILED');

      const changed = await updateChequeStatusRecord(client, {
        source,
        entryId,
        status,
        expectedSiteId: run.site_id,
        expectedAmount: candidate.amount,
        requirePending: true,
      });
      const linkResult = await client.query(
        `INSERT INTO bank_reconciliation_links (
           organization_id, site_id, upload_id, run_id, suggestion_id, bank_transaction_id,
           candidate_source, candidate_entry_id, resulting_status, bank_value_date,
           bank_reference, row_fingerprint, confirmed_by
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         RETURNING id, confirmed_at`,
        [run.organization_id, run.site_id, run.upload_id, runId, suggestion.id,
          suggestion.bank_transaction_id, source, entryId, status,
          suggestion.value_date || suggestion.transaction_date,
          suggestion.transaction_reference || suggestion.cheque_reference || null,
          suggestion.row_fingerprint, req.user.id]
      );
      await client.query(
        `UPDATE bank_reconciliation_suggestions
            SET candidate_source = $2, candidate_entry_id = $3, proposed_status = $4,
                match_origin = $5, review_state = 'CONFIRMED', override_reason = $6,
                overridden_by = CASE WHEN $6::text IS NULL THEN overridden_by ELSE $7 END,
                overridden_at = CASE WHEN $6::text IS NULL THEN overridden_at ELSE NOW() END
          WHERE id = $1`,
        [suggestion.id, source, entryId, status, origin, overrideReason, req.user.id]
      );
      await writeAuditLog({
        organizationId: run.organization_id,
        siteId: run.site_id,
        userId: req.user.id,
        action: status === 'BOUNCED' ? 'BOUNCE' : 'CLEAR',
        eventType: 'RECONCILIATION',
        module: 'bank_reconciliation',
        transactionName: candidate.customer_name || candidate.entry_label,
        amount: candidate.amount,
        entityType: source,
        entityId: entryId,
        outcome: 'SUCCESS',
        description: `Cheque ${candidate.cheque_no || `#${entryId}`} confirmed as ${status} from bank statement`,
        oldValues: { cheque_status: changed.before?.cheque_status },
        newValues: { cheque_status: status, reconciliation_link_id: linkResult.rows[0].id },
        metadata: {
          upload_id: Number(run.upload_id), run_id: runId, suggestion_id: Number(suggestion.id),
          bank_transaction_id: Number(suggestion.bank_transaction_id), matching_mode: run.mode,
          match_origin: origin, confidence: Number(suggestion.confidence),
          matched_signals: suggestion.matched_signals, conflicting_signals: suggestion.conflicting_signals,
          override_reason: overrideReason, row_fingerprint: suggestion.row_fingerprint,
        },
      }, client);
      effects.push({
        link_id: Number(linkResult.rows[0].id), suggestion_id: Number(suggestion.id),
        bank_transaction_id: Number(suggestion.bank_transaction_id), candidate_id: candidate.id,
        cheque_no: candidate.cheque_no, status, amount: candidate.amount,
      });
    }

    await client.query(`UPDATE bank_reconciliation_runs SET status = 'CONFIRMED', completed_at = COALESCE(completed_at, NOW()) WHERE id = $1`, [runId]);
    await client.query(`UPDATE bank_statement_uploads SET processing_state = 'CONFIRMED', updated_at = NOW() WHERE id = $1`, [run.upload_id]);
    await client.query('COMMIT');
    return res.json({
      message: `${effects.length} cheque${effects.length === 1 ? '' : 's'} updated successfully.`,
      effects,
      summary: {
        confirmed: effects.length,
        cleared: effects.filter((item) => item.status === 'CLEARED').length,
        bounced: effects.filter((item) => item.status === 'BOUNCED').length,
        reversals_created: 0,
        rows_skipped: 0,
      },
    });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    return sendError(res, error);
  } finally {
    client.release();
  }
}

export { AiResolverError };
