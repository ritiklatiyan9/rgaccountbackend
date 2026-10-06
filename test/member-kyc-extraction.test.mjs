import test from 'node:test';
import assert from 'node:assert/strict';
import { normaliseResult, extractMemberKycFromText, extractMemberKyc, resolveOpenRouterKycModel, DEFAULT_OPENROUTER_KYC_MODEL } from '../src/services/memberKycOcr.service.js';
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

test('normalization keeps printed date formats, Hindi gender and line-wrapped identifiers without accepting issuer headings',()=>{
  assert.deepEqual(result('full_name','Unique Identification Authority of India','Unique Identification Authority of India','Unique Identification Authority of India','AADHAAR'),{});
  assert.deepEqual(result('full_name','भारतीय विधिक पहचान प्राधिकरण','भारतीय विधिक पहचान प्राधिकरण','भारतीय विधिक पहचान प्राधिकरण','AADHAAR'),{});
  assert.deepEqual(result('state','आधार','आधार','आधार','AADHAAR'),{});
  assert.deepEqual(result('gender','MALE','पुरुष','पुरुष','AADHAAR'),{gender:'MALE'});
  assert.deepEqual(result('aadhar_no','234567891234','2345\n6789\n1234'),{aadhar_no:'234567891234'});
  for(const quote of ['DOB: 23-04-1990','DOB: 23.04.1990']) assert.deepEqual(result('date_of_birth','1990-04-23',quote),{date_of_birth:'1990-04-23'});
});

test('KYC defaults to Flash-Lite and replaces previous model pins while preserving explicit alternatives',t=>{
  const original=process.env.OPENROUTER_KYC_MODEL;
  t.after(()=>{if(original===undefined) delete process.env.OPENROUTER_KYC_MODEL;else process.env.OPENROUTER_KYC_MODEL=original;});
  assert.equal(DEFAULT_OPENROUTER_KYC_MODEL,'google/gemini-3.1-flash-lite');
  delete process.env.OPENROUTER_KYC_MODEL;
  assert.equal(resolveOpenRouterKycModel(),DEFAULT_OPENROUTER_KYC_MODEL);
  for(const configured of ['', '   ', 'qwen/qwen3-vl-30b-a3b-instruct', 'google/gemini-3.1-pro-preview', ' google/gemini-3.1-pro-preview ']) {
    process.env.OPENROUTER_KYC_MODEL=configured;
    assert.equal(resolveOpenRouterKycModel(),DEFAULT_OPENROUTER_KYC_MODEL);
  }
  process.env.OPENROUTER_KYC_MODEL=' custom/vision-model ';
  assert.equal(resolveOpenRouterKycModel(),'custom/vision-model');
});

test('KYC reads original images and PDFs with Flash-Lite even when Pro is pinned before structuring evidence',async t=>{
  const keys=['KYC_AI_ENGINE','OPENROUTER_API_KEY','OPENROUTER_KYC_MODEL','OPENROUTER_KYC_PDF_ENGINE'];
  const original=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
  process.env.KYC_AI_ENGINE='openrouter';process.env.OPENROUTER_API_KEY='test-key';
  process.env.OPENROUTER_KYC_MODEL='google/gemini-3.1-pro-preview';delete process.env.OPENROUTER_KYC_PDF_ENGINE;
  t.after(()=>{for(const key of keys) {if(original[key]===undefined) delete process.env[key];else process.env[key]=original[key];}});
  assert.equal(resolveOpenRouterKycModel(),DEFAULT_OPENROUTER_KYC_MODEL);
  const requests=[];
  t.mock.method(globalThis,'fetch',async(_url,options)=>{
    const body=JSON.parse(options.body);requests.push(body);
    const content=Array.isArray(body.messages[0].content) ? 'Name: Raj Kumar' : JSON.stringify(payload('full_name','Raj Kumar','Name: Raj Kumar'));
    return new Response(JSON.stringify({choices:[{message:{content}}]}),{status:200,headers:{'Content-Type':'application/json'}});
  });
  const imageResult=await extractMemberKyc(Buffer.from('fixture image'),'image/jpeg','AADHAAR');
  assert.deepEqual(imageResult.fields,{full_name:'Raj Kumar'});
  assert.equal(imageResult.engine,'or:gemini-3.1-flash-lite');
  assert.equal(requests[0].model,DEFAULT_OPENROUTER_KYC_MODEL);assert.equal(requests[1].model,DEFAULT_OPENROUTER_KYC_MODEL);
  assert.equal(requests[0].messages[0].content[1].image_url.detail,'high');assert.equal(requests[1].response_format.type,'json_object');
  assert.deepEqual((await extractMemberKyc(Buffer.from('%PDF-fixture'),'application/pdf','AADHAAR')).fields,{full_name:'Raj Kumar'});
  assert.equal(requests.length,4);
  assert.ok(requests.every(request=>request.model==='google/gemini-3.1-flash-lite'));
  assert.deepEqual(requests[2].plugins,[{id:'file-parser',pdf:{engine:'native'}}]);
  process.env.OPENROUTER_KYC_MODEL='custom/vision-model';assert.equal(resolveOpenRouterKycModel(),'custom/vision-model');
});
