import assert from 'node:assert/strict';
import test from 'node:test';
import { getConfiguration, requireAiMatchMode, requireChequeListStatus, transactionDto } from '../src/controllers/bankReconciliation.controller.js';

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
