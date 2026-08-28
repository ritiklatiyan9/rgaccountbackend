import pool from '../config/db.js';
import { clearCacheByPrefixes } from '../config/cache.js';
import { writeAuditLog } from '../services/auditLog.service.js';
import { parseBankStatement } from '../services/bankStatementParser.service.js';
import {
  BANK_DAYBOOK_MATCHER_VERSION,
  candidateSnapshotHash,
  canonicalMatchedKeys,
  exactStatementCandidatePair,
  loadBankDaybookCandidates,
  reconcileBankDaybookRows,
} from '../services/bankDaybookReconciliation.service.js';
import { applyBankDaybookOrder } from '../services/bankDaybookOrder.service.js';

const numericId = (value, label) => {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    const error = new Error(`A valid ${label} is required.`);
    error.statusCode = 400;
    error.code = 'INVALID_ID';
    throw error;
  }
  return parsed;
};

const sendError = (res, error) => {
  const status = Number(error.statusCode) || 500;
  if (status >= 500 && !error.statusCode) console.error('[bank-daybook-reconciliation]', error);
  return res.status(status).json({
    message: status >= 500 && !error.statusCode
      ? 'Bank Day Book reconciliation could not be completed.'
      : error.message,
    code: error.code || 'BANK_DAYBOOK_RECONCILIATION_ERROR',
    ...(error.orderRevision == null ? {} : { order_revision: error.orderRevision }),
    ...(error.details == null ? {} : { details: error.details }),
  });
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
  if (!site || !site.assigned) {
    const error = new Error('The selected site is outside your authorised workspace.');
    error.statusCode = 403;
    error.code = 'SITE_ACCESS_DENIED';
    throw error;
  }
  return site;
}

async function resolveScope(db, rawScope) {
  const scope = String(rawScope || 'all').trim().toLowerCase();
  if (scope === 'all') return { scope, bank: null };
  if (scope === 'unmapped') return { scope, bank: null };
  if (!/^\d+$/.test(scope)) {
    const error = new Error('Bank scope must be all, unmapped, or a configured bank account.');
    error.statusCode = 400;
    error.code = 'INVALID_BANK_SCOPE';
    throw error;
  }
  const result = await db.query('SELECT id, name, account_no, is_active FROM bank_accounts WHERE id = $1', [Number(scope)]);
  if (!result.rows[0]) {
    const error = new Error('The selected bank account no longer exists.');
    error.statusCode = 404;
    error.code = 'BANK_ACCOUNT_NOT_FOUND';
    throw error;
  }
  return { scope, bank: result.rows[0] };
}

async function accountWarning(db, parsed, bank, scope) {
  if (!parsed.metadata.statement_account_suffix) return null;
  const statementSuffix = String(parsed.metadata.statement_account_suffix).toUpperCase();
  if (bank) {
    const configuredSuffix = String(bank.account_no || '').replace(/[^0-9A-Za-z]/g, '').slice(-4).toUpperCase();
    if (!configuredSuffix || configuredSuffix === statementSuffix) return null;
    return `Statement account ends in ${statementSuffix}, but ${bank.name} ends in ${configuredSuffix}.`;
  }
  const configured = await db.query(
    `SELECT id, name
       FROM bank_accounts
      WHERE RIGHT(UPPER(REGEXP_REPLACE(COALESCE(account_no, ''), '[^0-9A-Za-z]', '', 'g')), 4) = $1
      ORDER BY is_active DESC, id
      LIMIT 1`,
    [statementSuffix]
  );
  if (!configured.rows[0]) {
    return `Statement account ends in ${statementSuffix}, but no configured ERP bank account has that suffix. Current scope is ${scope === 'unmapped' ? 'unmapped entries' : 'all non-cash entries'}.`;
  }
  if (scope === 'all') {
    return `Statement account appears to be ${configured.rows[0].name} (…${statementSuffix}), but matching currently includes all non-cash entries.`;
  }
  return null;
}

const parseStatement = (req) => {
  if (!req.file?.buffer?.length) {
    const error = new Error('Choose one Excel or CSV bank statement.');
    error.statusCode = 400;
    error.code = 'STATEMENT_REQUIRED';
    throw error;
  }
  return parseBankStatement(req.file.buffer, req.file.originalname);
};

export async function previewBankDaybookReconciliation(req, res) {
  try {
    const site = await assertSiteAccess(pool, req.user, req.body.site_id ?? req.body.siteId);
    const { scope, bank } = await resolveScope(pool, req.body.bank_scope ?? req.body.bankScope);
    const parsed = parseStatement(req);
    const candidates = await loadBankDaybookCandidates(pool, {
      siteId: site.id,
      scope,
      dateFrom: parsed.metadata.date_from,
      dateTo: parsed.metadata.date_to,
    });
    const [matching, revisionResult] = await Promise.all([
      Promise.resolve(reconcileBankDaybookRows(parsed.rows, candidates)),
      pool.query('SELECT revision FROM daybook_global_order_state WHERE site_id = $1', [site.id]),
    ]);
    const warning = await accountWarning(pool, parsed, bank, scope);
    return res.json({
      preview: {
        file_name: req.file.originalname,
        file_hash: parsed.fileHash,
        parser_version: parsed.parserVersion,
        matcher_version: BANK_DAYBOOK_MATCHER_VERSION,
        site_id: Number(site.id),
        site_name: site.name,
        bank_scope: scope,
        bank: bank ? {
          id: Number(bank.id),
          name: bank.name,
          account_suffix: String(bank.account_no || '').replace(/[^0-9A-Za-z]/g, '').slice(-4),
        } : null,
        metadata: parsed.metadata,
        mapped_headers: parsed.mappedHeaders,
        integrity: parsed.integrity,
        parse_error_count: parsed.parseErrorCount,
        account_warning: warning,
        candidate_snapshot: candidateSnapshotHash(candidates),
        order_revision: Number(revisionResult.rows[0]?.revision) || 0,
      },
      rows: matching.rows,
      summary: matching.summary,
    });
  } catch (error) {
    return sendError(res, error);
  }
}

function parseSelections(value) {
  let parsed;
  try {
    parsed = typeof value === 'string' ? JSON.parse(value) : value;
  } catch {
    parsed = null;
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > 100000) {
    const error = new Error('Select between 1 and 100000 exact statement matches.');
    error.statusCode = 400;
    error.code = 'INVALID_MATCH_SELECTION';
    throw error;
  }
  return parsed.map((selection) => ({
    row_number: numericId(selection?.row_number ?? selection?.rowNumber, 'statement row number'),
    entry_key: String(selection?.entry_key ?? selection?.entryKey ?? '').trim(),
  }));
}

const truthy = (value) => value === true || String(value).toLowerCase() === 'true';

export async function applyBankDaybookReconciliation(req, res) {
  let client;
  try {
    const siteId = numericId(req.body.site_id ?? req.body.siteId, 'site id');
    const requestId = String(req.body.request_id ?? req.body.requestId ?? '').trim();
    if (!/^[A-Za-z0-9._:-]{8,128}$/.test(requestId)) {
      const error = new Error('request_id is invalid.');
      error.statusCode = 400;
      error.code = 'INVALID_REQUEST_ID';
      throw error;
    }
    const expectedRevision = Number(req.body.expected_revision ?? req.body.expectedRevision);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      const error = new Error('expected_revision must be a non-negative integer.');
      error.statusCode = 400;
      error.code = 'INVALID_ORDER_REVISION';
      throw error;
    }
    const expectedSnapshot = String(req.body.candidate_snapshot ?? req.body.candidateSnapshot ?? '');
    if (!/^[a-f0-9]{64}$/.test(expectedSnapshot)) {
      const error = new Error('The reconciliation preview is missing or invalid. Upload the statement again.');
      error.statusCode = 400;
      error.code = 'INVALID_PREVIEW_SNAPSHOT';
      throw error;
    }
    const selections = parseSelections(req.body.matches);
    if (new Set(selections.map((item) => item.row_number)).size !== selections.length
        || new Set(selections.map((item) => item.entry_key)).size !== selections.length) {
      const error = new Error('A statement row or ERP entry cannot be selected more than once.');
      error.statusCode = 400;
      error.code = 'DUPLICATE_MATCH_SELECTION';
      throw error;
    }
    if (selections.some((item) => !/^[a-z_]+:[A-Za-z0-9:.-]+$/.test(item.entry_key) || item.entry_key.length > 160)) {
      const error = new Error('One or more selected ERP entry keys are invalid.');
      error.statusCode = 400;
      error.code = 'INVALID_ENTRY_KEY';
      throw error;
    }

    const parsed = parseStatement(req);
    if (String(req.body.file_hash ?? req.body.fileHash ?? '') !== parsed.fileHash) {
      const error = new Error('The confirmation file is not the same file that was previewed.');
      error.statusCode = 409;
      error.code = 'STATEMENT_FILE_CHANGED';
      throw error;
    }
    if (parsed.parseErrorCount > 0) {
      const error = new Error(`${parsed.parseErrorCount} statement row(s) have parsing errors. Correct the file before applying an order.`);
      error.statusCode = 422;
      error.code = 'STATEMENT_PARSE_ERRORS';
      throw error;
    }
    if (parsed.integrity.statement_order === 'MIXED') {
      const error = new Error('The statement transaction dates are not consistently oldest-first or newest-first. Sort the file before applying it.');
      error.statusCode = 422;
      error.code = 'MIXED_STATEMENT_ORDER';
      throw error;
    }
    if (parsed.integrity.balance_mismatch_count > 0) {
      const error = new Error(`The running balance chain breaks on ${parsed.integrity.balance_mismatch_count} row(s). Apply is blocked.`);
      error.statusCode = 422;
      error.code = 'BALANCE_CHAIN_MISMATCH';
      throw error;
    }

    client = await pool.connect();
    await client.query('BEGIN');
    const site = await assertSiteAccess(client, req.user, siteId);
    const { scope, bank } = await resolveScope(client, req.body.bank_scope ?? req.body.bankScope);
    const warning = await accountWarning(client, parsed, bank, scope);
    if (warning && !truthy(req.body.acknowledge_account_mismatch)) {
      const error = new Error(`${warning} Confirm the account mismatch explicitly before applying.`);
      error.statusCode = 409;
      error.code = 'BANK_ACCOUNT_MISMATCH';
      throw error;
    }

    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`daybook-global-order:${site.id}`]);
    const priorRequest = await client.query(
      'SELECT revision, last_request_id FROM daybook_global_order_state WHERE site_id = $1',
      [site.id]
    );
    if (priorRequest.rows[0]?.last_request_id === requestId) {
      await client.query('COMMIT');
      return res.json({
        message: 'This bank-statement order was already applied.',
        already_applied: true,
        order_revision: Number(priorRequest.rows[0].revision) || expectedRevision,
      });
    }

    const candidates = await loadBankDaybookCandidates(client, {
      siteId: site.id,
      scope,
      dateFrom: parsed.metadata.date_from,
      dateTo: parsed.metadata.date_to,
    });
    if (candidateSnapshotHash(candidates) !== expectedSnapshot) {
      const error = new Error('ERP bank entries or their order changed after preview. Upload the statement again before applying.');
      error.statusCode = 409;
      error.code = 'STALE_RECONCILIATION_PREVIEW';
      throw error;
    }

    const rowMap = new Map(parsed.rows.map((row) => [Number(row.rowNumber), row]));
    const candidateMap = new Map(candidates.map((candidate) => [candidate.entry_key, candidate]));
    const validated = selections.map((selection) => {
      const row = rowMap.get(selection.row_number);
      const candidate = candidateMap.get(selection.entry_key);
      if (!row || !candidate) {
        throw Object.assign(new Error('A selected statement row or ERP entry is no longer available.'), {
          statusCode: 409,
          code: 'STALE_MATCH_SELECTION',
        });
      }
      if (!exactStatementCandidatePair(row, candidate)) {
        throw Object.assign(new Error(`Statement row ${selection.row_number} does not exactly match the selected ERP date, direction, and amount.`), {
          statusCode: 409,
          code: 'MATCH_DATA_MISMATCH',
        });
      }
      return {
        row_number: selection.row_number,
        entry_key: selection.entry_key,
        date: candidate.date,
        amount: candidate.amount,
        direction: candidate.direction,
      };
    });

    const selectedKeys = new Set(validated.map((item) => item.entry_key));
    const inPeriodCandidates = candidates.filter((candidate) => candidate.in_statement_period);
    const unresolvedStatementRows = parsed.rows.length - validated.length;
    const extraDatabaseRows = inPeriodCandidates.filter((candidate) => !selectedKeys.has(candidate.entry_key)).length;
    const allowPartial = truthy(req.body.allow_partial ?? req.body.allowPartial);
    if (!allowPartial && (unresolvedStatementRows > 0 || extraDatabaseRows > 0)) {
      const error = new Error('Exact reconciliation is incomplete. Resolve every statement row and extra ERP row, or explicitly allow a partial reorder.');
      error.statusCode = 409;
      error.code = 'INCOMPLETE_RECONCILIATION';
      error.details = {
        unresolved_statement_rows: unresolvedStatementRows,
        extra_database_rows: extraDatabaseRows,
      };
      throw error;
    }

    const canonicalMatches = canonicalMatchedKeys(validated, parsed.integrity.statement_order);
    const orderResult = await applyBankDaybookOrder(client, {
      siteId: site.id,
      canonicalMatches,
      userId: req.user.id,
      requestId,
      expectedGlobalRevision: expectedRevision,
    });
    await writeAuditLog({
      organizationId: site.organization_id,
      siteId: site.id,
      userId: req.user.id,
      action: 'REORDER',
      eventType: 'RECONCILIATION',
      module: 'bank_daybook',
      transactionName: req.file.originalname,
      entityType: 'bank_statement',
      entityId: null,
      outcome: 'SUCCESS',
      description: `Bank Day Book order reconciled from ${req.file.originalname}`,
      newValues: {
        matched_entries: validated.length,
        dates_reordered: orderResult.dates,
        partial: allowPartial,
      },
      metadata: {
        file_hash: parsed.fileHash,
        parser_version: parsed.parserVersion,
        matcher_version: BANK_DAYBOOK_MATCHER_VERSION,
        bank_scope: scope,
        statement_account_suffix: parsed.metadata.statement_account_suffix,
        statement_order: parsed.integrity.statement_order,
        unresolved_statement_rows: unresolvedStatementRows,
        extra_database_rows: extraDatabaseRows,
        request_id: requestId,
      },
    }, client);
    await client.query('COMMIT');
    await clearCacheByPrefixes(['daybook|', 'balance-sheet|']);
    return res.json({
      message: `${validated.length} exact bank entr${validated.length === 1 ? 'y' : 'ies'} reordered from the statement.`,
      already_applied: orderResult.already_applied,
      applied: validated.length,
      dates: orderResult.dates,
      changed_positions: orderResult.changed,
      unresolved_statement_rows: unresolvedStatementRows,
      extra_database_rows: extraDatabaseRows,
      partial: allowPartial,
      statement_order: parsed.integrity.statement_order,
      order_revision: orderResult.order_revision,
    });
  } catch (error) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    return sendError(res, error);
  } finally {
    client?.release();
  }
}
