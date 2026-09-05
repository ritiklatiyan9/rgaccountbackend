import test from 'node:test';
import assert from 'node:assert/strict';
import { normaliseResult, extractMemberKycFromText } from '../src/services/memberKycOcr.service.js';
import { reviewDocument, combineReviewedDocuments } from '../src/services/memberKycReview.service.js';

const payload = (field, value, quote = value, score = 0.99) => ({
  fields: { [field]: value }, confidence: { [field]: score }, evidence: { [field]: quote },
});
const result = (field, value, quote, text = quote, type = 'OTHER', score = 0.99) =>
  normaliseResult(payload(field, value, quote, score), text, type).fields;

test('requires literal evidence and explicit high confidence, even for plausible data', () => {
  assert.deepEqual(result('full_name', 'Raj Kumar', 'Raj Kumar', 'Amit Sharma'), {});
  assert.deepEqual(normaliseResult({ fields: { full_name: 'Raj Kumar' }, confidence: { full_name: 1 } }, 'Raj Kumar').fields, {});
  for (const score of [null, '0.99', 0.89, 1.1, NaN]) assert.deepEqual(result('full_name', 'Raj Kumar', 'Raj Kumar', 'Raj Kumar', 'OTHER', score), {});
  assert.deepEqual(result('full_name', { name: 'Raj' }, 'Raj'), {});
  assert.deepEqual(result('full_name', 'Raj Kumar', 'Name: Raj Kumar'), { full_name: 'Raj Kumar' });
});

test('does not infer demographics, relatives, nominee or WhatsApp', () => {
  assert.deepEqual(result('nationality', 'Indian', 'Indian government', 'Indian government', 'AADHAAR'), {});
  assert.deepEqual(result('religion', 'Hindu', 'Hindu'), {});
  assert.deepEqual(result('father_name', 'Raj Kumar', 'C/O Raj Kumar', 'C/O Raj Kumar', 'AADHAAR'), {});
  assert.deepEqual(result('father_name', 'Raj Kumar', 'Husband: Raj Kumar'), {});
  assert.deepEqual(result('spouse_name', 'Raj Kumar', 'W/O Raj Kumar'), { spouse_name: 'Raj Kumar' });
  assert.deepEqual(result('nominee_name', 'Raj Kumar', 'Name: Raj Kumar'), {});
  assert.deepEqual(result('whatsapp', '9876543210', 'Mobile: 9876543210'), {});
  assert.deepEqual(result('full_name', 'Payee Person', 'Payee Person', 'Payee Person', 'CHEQUE'), {});
});

test('rejects partial, impossible and future birth dates and preserves complete dates', () => {
  for (const [value, quote] of [['1990-01-01', 'Year of Birth: 1990'], ['1990-02-31', 'DOB: 31/02/1990'], ['2990-01-01', 'DOB: 01/01/2990']]) {
    assert.deepEqual(result('date_of_birth', value, quote), {});
  }
  assert.deepEqual(result('date_of_birth', '1990-04-23', 'DOB: 23/04/1990'), { date_of_birth: '1990-04-23' });
});

test('preserves printed numbers without inventing or truncating digits', () => {
  assert.deepEqual(result('aadhar_no', '234567891234', '2345 6789 1234'), { aadhar_no: '234567891234' });
  assert.deepEqual(result('aadhar_no', '234567891234', 'XXXX XXXX 1234'), {});
  assert.deepEqual(result('phone', '9876543210', 'Phone: 1239876543210'), {});
  assert.deepEqual(result('phone', '1239876543210', 'Phone: 1239876543210'), {});
  assert.deepEqual(result('phone', '+919876543210', 'Phone: +91 98765 43210'), { phone: '9876543210' });
  assert.deepEqual(result('pan_no', 'ABCDE1234F', 'ABCDE1234F'), { pan_no: 'ABCDE1234F' });
  assert.deepEqual(result('pan_no', 'ABC0E1234F', 'ABC0E1234F'), {});
  assert.deepEqual(result('account_no', '00123456789', 'Account: 00123456789'), { account_no: '00123456789' });
});

const document = (id, value) => ({ id, type: 'PAN', ocr_status: 'DONE',
  extracted_fields: { full_name: value }, confidence_map: { full_name: 0.99 },
  raw_text: { text: `Name: ${value}`, evidence: { full_name: `Name: ${value}` } },
});
test('withholds conflicting values and exposes source references for agreement', () => {
  const conflict = combineReviewedDocuments([document(1, 'Raj Kumar'), document(2, 'Amit Sharma')]);
  assert.deepEqual(conflict.extracted, {});
  assert.equal(conflict.conflicts.full_name.length, 2);
  const agreement = combineReviewedDocuments([document(1, 'Raj Kumar'), document(2, 'RAJ KUMAR')]);
  assert.equal(agreement.extracted.full_name, 'Raj Kumar');
  assert.equal(agreement.evidence.full_name.documentId, 1);
});
test('old results and unfinished retries cannot fill fields', () => {
  const legacy = { ...document(1, 'Raj Kumar'), raw_text: { text: 'Raj Kumar' } };
  assert.deepEqual(reviewDocument(legacy).extracted_fields, {});
  assert.equal(reviewDocument(legacy).needs_reprocessing, true);
  assert.deepEqual(reviewDocument({ ...document(1, 'Raj Kumar'), ocr_status: 'PROCESSING' }).extracted_fields, {});
  assert.equal(reviewDocument(document(1, 'Raj Kumar')).raw_text, undefined);
});
test('model integration drops unsupported fields and requests evidence', async (t) => {
  const oldEngine = process.env.KYC_AI_ENGINE;
  const oldKey = process.env.OPENROUTER_API_KEY;
  process.env.KYC_AI_ENGINE = 'openrouter';
  process.env.OPENROUTER_API_KEY = 'test-key';
  t.after(() => {
    if (oldEngine === undefined) delete process.env.KYC_AI_ENGINE; else process.env.KYC_AI_ENGINE = oldEngine;
    if (oldKey === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = oldKey;
  });
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    const request = JSON.parse(options.body);
    assert.match(request.messages[1].content, /verbatim evidence/);
    return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({
      fields: { full_name: 'Raj Kumar', nationality: 'Indian' },
      confidence: { full_name: 0.99, nationality: 1 },
      evidence: { full_name: 'Name: Raj Kumar', nationality: 'Indian' },
    }) } }] }) };
  });
  assert.deepEqual((await extractMemberKycFromText('Name: Raj Kumar', 'AADHAAR')).fields, { full_name: 'Raj Kumar' });
});
