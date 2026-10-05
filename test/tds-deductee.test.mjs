import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveTdsDeductee } from '../src/services/tdsDeductee.service.js';

test('the selected Client KYC overrides stale or forged form values', async () => {
  const db = { query: async (_sql, args) => { assert.deepEqual(args,[5,2]); return { rows:[{ id:5,full_name:'Agent',pan_no:'abcde1234f',aadhar_no:'1234 5678 9012' }] }; } };
  const result = await resolveTdsDeductee({ tds_member_id:5,tds_deductee_name:'Other name',tds_pan:'FGHIJ1234K' },2,null,db);
  assert.deepEqual(result,{tds_member_id:5,tds_deductee_name:'Agent',tds_pan:'ABCDE1234F',tds_aadhaar:'123456789012'});
});
test('clearing the Client does not retain a previous taxpayer mapping', async () => {
  const result = await resolveTdsDeductee({tds_member_id:null,tds_deductee_name:'Manual payee',tds_pan:'',tds_aadhaar:''},2,{tds_member_id:5,tds_pan:'ABCDE1234F'});
  assert.deepEqual(result,{tds_member_id:null,tds_deductee_name:'Manual payee',tds_pan:null,tds_aadhaar:null});
});
test('cross-site clients and malformed KYC are rejected', async () => {
  await assert.rejects(resolveTdsDeductee({tds_member_id:5},2,null,{query:async()=>({rows:[]})}),/not available/);
  await assert.rejects(resolveTdsDeductee({tds_member_id:'bad'},2),/valid TDS client/);
  await assert.rejects(resolveTdsDeductee({tds_pan:'BAD'},2),/PAN/);
  await assert.rejects(resolveTdsDeductee({tds_aadhaar:'123'},2),/Aadhaar/);
});
test('unchanged source KYC keeps its snapshot when the Client profile changes later', async () => {
  const original = {tds_member_id:5,tds_deductee_name:'Original Agent',tds_pan:'ABCDE1234F',tds_aadhaar:'123456789012'};
  const db = {query:async()=>{throw new Error('A metadata edit must not refresh taxpayer details');}};
  assert.deepEqual(await resolveTdsDeductee({remarks:'Proof attached'},2,original,db),original);
  assert.deepEqual(await resolveTdsDeductee({...original,remarks:'Proof attached'},2,original,db),original);
});
