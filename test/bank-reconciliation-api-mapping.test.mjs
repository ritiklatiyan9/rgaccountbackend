import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import pool from '../src/config/db.js';
import {
  getConfiguration,
  requireAiMatchMode,
  requireChequeListStatus,
  requireManualStatusReason,
  requireManualChequeStatus,
  transactionDto,
  listPendingCheques,
  getRun,
} from '../src/controllers/bankReconciliation.controller.js';

test('cheque date support is advertised only after the schema-backed list read succeeds', async () => {
  const originalQuery = pool.query;
  const originalError = console.error;
  let schemaReadSucceeds = true;
  try {
    pool.query = async (sql) => {
      if (sql.includes('FROM sites s')) return { rows: [{ id: 8, name: 'Site', organization_id: 1, assigned: true }] };
      assert.match(sql, /cfe\.cheque_transaction_date/);
      if (!schemaReadSucceeds) throw Object.assign(new Error('column does not exist'), { code: '42703' });
      return { rows: [] };
    };
    const invoke = async () => {
      let code = 200, body;
      await listPendingCheques({ user: { id: 1, role: 'admin', organization_id: 1 }, query: { site_id: 8, status: 'ALL' } }, {
        status(value) { code = value; return this; }, json(value) { body = value; return this; },
      });
      return { code, body };
    };
    assert.equal((await invoke()).body.cheque_dates_supported, true);
    schemaReadSucceeds = false;
    console.error = () => {};
    const missing = await invoke();
    assert.equal(missing.code, 500);
    assert.equal(missing.body.cheque_dates_supported, undefined);
  } finally {
    pool.query = originalQuery;
    console.error = originalError;
  }
});

test('saved confirmed run refreshes historical candidate snapshots from the authorised site', async () => {
  const originalQuery = pool.query;
  let currentStatus = 'CLEARED';
  const canonicalReads = [];
  const legacySnapshot = { candidate_id: 'plot_payment:7', source: 'plot_payment', entry_id: 7, date: '2026-08-10', cheque_status: 'PENDING', score: 99 };
  try {
    pool.query = async (sql, params) => {
      if (sql.includes('FROM bank_reconciliation_runs r')) return { rows: [{ id: 12, upload_id: 4, site_id: 8, organization_id: 1, status: 'CONFIRMED' }] };
      if (sql.includes('FROM sites s')) return { rows: [{ id: 8, name: 'Site', organization_id: 1, assigned: true }] };
      if (sql.includes('FROM bank_reconciliation_suggestions s')) return { rows: [
        { id: 5, transaction_row_id: 6, upload_id: 4, row_number: 2, candidate_source: 'plot_payment', candidate_entry_id: 7,
          review_state: 'CONFIRMED', proposed_status: 'CLEARED', alternatives: [legacySnapshot, { candidate_id: 'expense:999', cheque_status: 'PENDING' }] },
        { id: 8, transaction_row_id: 9, upload_id: 4, row_number: 3, candidate_source: 'plot_payment', candidate_entry_id: 7,
          review_state: 'CONFIRMED', proposed_status: 'CLEARED', alternatives: [] },
      ] };
      assert.match(sql, /JOIN sites s ON s\.id = cfe\.site_id AND s\.organization_id = \$1/);
      assert.match(sql, /WHERE cfe\.site_id = \$2/);
      canonicalReads.push(params);
      return { rows: [{ source: 'plot_payment', entry_id: 7, ledger_id: 70, site_id: 8, amount: '250', date: '2026-08-10',
        cheque_status: currentStatus, cheque_transaction_date: '2026-08-22', aliases: [] }] };
    };
    const invoke = async () => {
      let body;
      await getRun({ user: { id: 1, role: 'admin', organization_id: 1 }, params: { runId: 12 } }, {
        status() { return this; }, json(value) { body = value; return this; },
      });
      return body;
    };
    const cleared = await invoke();
    for (const row of cleared.suggestions) {
      assert.equal(row.candidate.cheque_status, 'CLEARED');
      assert.equal(row.candidate.cheque_apply_date, '2026-08-10');
      assert.equal(row.candidate.cheque_transaction_date, '2026-08-22');
    }
    assert.equal(cleared.suggestions[0].alternatives[0].cheque_transaction_date, '2026-08-22');
    assert.equal(cleared.suggestions[0].alternatives[0].score, 99, 'saved matching evidence stays intact');
    assert.equal(cleared.suggestions[0].alternatives[1].cheque_status, 'PENDING', 'unresolved identities are not refreshed from another scope');
    assert.equal(legacySnapshot.cheque_status, 'PENDING', 'persisted audit snapshot is not rewritten');
    currentStatus = 'PENDING';
    const reopened = await invoke();
    assert.equal(reopened.suggestions[0].candidate.cheque_status, 'PENDING');
    assert.equal(reopened.suggestions[0].candidate.cheque_transaction_date, null, 'an old confirmed run cannot resurrect a reopened clearance');
    assert.deepEqual(canonicalReads, [[1, 8, null], [1, 8, null]], 'one site-scoped batch covers selected and alternative candidates per read');
  } finally { pool.query = originalQuery; }
});

test('bank reconciliation API DTO preserves imported lineage fields and blank references', () => {
  const dto = transactionDto({
    id: '41', upload_id: '7', row_number: '4', transaction_date: '2026-08-22', value_date: '2026-08-22',
    transaction_reference: 'MV-BNK-0003', cheque_reference: '', narration: 'CTS/778 MOHIT TYG PLOT-A10 SETTLED',
    debit: null, credit: '375000.00', balance: '5625000.00', account_suffix: '4412', branch: 'MUZAFFARNAGAR',
    raw_row: { 'Description / Narration': 'CTS/778 MOHIT TYG PLOT-A10 SETTLED', 'Cheque / Reference No.': '' },
    normalized_row: { narration: 'CTS/778 MOHIT TYG PLOT-A10 SETTLED', cheque_reference: '' },
    row_fingerprint: 'a'.repeat(64), parse_errors: [],
  });
  assert.equal(dto.transaction_date, '2026-08-22');
  assert.equal(dto.narration, 'CTS/778 MOHIT TYG PLOT-A10 SETTLED');
  assert.equal(dto.cheque_reference, '');
  assert.equal(dto.raw_row['Cheque / Reference No.'], '');
  assert.deepEqual(dto.parse_errors, []);
});

test('bank reconciliation API serializes database DATE values without UTC day rollback', () => {
  const dto = transactionDto({ id: 1, upload_id: 1, row_number: 2,
    transaction_date: new Date(2026, 7, 20), value_date: new Date(2026, 7, 21),
    debit: null, credit: '500000.00', raw_row: {}, normalized_row: {}, parse_errors: [],
  });
  assert.equal(dto.transaction_date, '2026-08-20');
  assert.equal(dto.value_date, '2026-08-21');
});

test('bank reconciliation configuration exposes Groq without exposing its API key', async () => {
  const previousKey = process.env.GROQ_API_KEY;
  const previousModel = process.env.GROQ_MODEL;
  process.env.GROQ_API_KEY = 'secret-test-key';
  process.env.GROQ_MODEL = 'llama-3.3-70b-versatile';
  let payload;
  try {
    await getConfiguration({}, { json: (value) => { payload = value; return value; } });
    assert.equal(payload.ai.available, true);
    assert.equal(payload.ai.provider, 'groq');
    assert.equal(payload.ai.model, 'llama-3.3-70b-versatile');
    assert.equal(payload.ai.fallback_model, 'openai/gpt-oss-120b');
    assert.equal(JSON.stringify(payload).includes('secret-test-key'), false);
  } finally {
    if (previousKey == null) delete process.env.GROQ_API_KEY;
    else process.env.GROQ_API_KEY = previousKey;
    if (previousModel == null) delete process.env.GROQ_MODEL;
    else process.env.GROQ_MODEL = previousModel;
  }
});

test('bank reconciliation matching API accepts only the AI flow', () => {
  assert.equal(requireAiMatchMode(undefined), 'AI');
  assert.equal(requireAiMatchMode('ai'), 'AI');
  assert.throws(
    () => requireAiMatchMode('manual'),
    (error) => error.code === 'INVALID_MATCH_MODE' && error.statusCode === 400,
  );
});

test('cheque history status filter is strict and defaults to pending', () => {
  assert.equal(requireChequeListStatus(undefined), 'PENDING');
  assert.equal(requireChequeListStatus('bounced'), 'BOUNCED');
  assert.equal(requireChequeListStatus('all'), 'ALL');
  assert.throws(
    () => requireChequeListStatus('deleted'),
    (error) => error.code === 'INVALID_CHEQUE_STATUS' && error.statusCode === 400,
  );
});

test('manual cheque status requires a concise audit reason', () => {
  assert.equal(requireManualStatusReason('  Verified   with bank manager  '), 'Verified with bank manager');
  assert.throws(
    () => requireManualStatusReason('ok'),
    (error) => error.code === 'MANUAL_STATUS_REASON_REQUIRED' && error.statusCode === 400,
  );
  assert.throws(
    () => requireManualStatusReason('x'.repeat(501)),
    (error) => error.code === 'MANUAL_STATUS_REASON_TOO_LONG' && error.statusCode === 400,
  );
});

test('manual cheque status route is permission gated and auditable', async () => {
  const [routes, controller] = await Promise.all([
    readFile(new URL('../src/routes/bankReconciliation.routes.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/controllers/bankReconciliation.controller.js', import.meta.url), 'utf8'),
  ]);
  assert.match(routes, /cheques\/:source\/:entryId\/manual-status[\s\S]*requirePermission\('expense_approval', 'update'\)/);
  const manualHandler = controller.slice(controller.indexOf('export async function manuallyUpdateChequeStatus'));
  assert.match(manualHandler, /loadPendingChequeCandidates\([\s\S]*null/);
  assert.match(manualHandler, /chequeTransactionDate: req\.body\.cheque_transaction_date/);
  assert.match(controller, /chequeTransactionDate: status === 'CLEARED' \? dateOnlyDto\(suggestion\.transaction_date \|\| suggestion\.value_date\)/);
  assert.match(controller, /eventType: 'MANUAL_CHEQUE_STATUS'/);
  assert.match(controller, /bank_statement_linked: false/);
});

test('manual cheque status accepts all four lifecycle decisions', () => {
  for (const status of ['PENDING', 'CLEARED', 'BOUNCED', 'RETURNED']) assert.equal(requireManualChequeStatus(status), status);
  assert.throws(
    () => requireManualChequeStatus('APPROVED'),
    (error) => error.code === 'INVALID_MANUAL_CHEQUE_STATUS' && error.statusCode === 400,
  );
});
