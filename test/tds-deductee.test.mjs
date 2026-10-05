import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveTdsDeductee, resolvePaymentDeductee } from '../src/services/tdsDeductee.service.js';

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

const clientDb = { query: async (_sql, args) => ({ rows: [{ id: args[0], full_name: `Client ${args[0]}`, pan_no: 'ABCDE1234F', aadhar_no: '123456789012' }] }) };
test('a payment copies its module party KYC without any duplicate TDS form inputs', async () => {
  const result = await resolvePaymentDeductee({}, 2, null, { memberId: 5, name: 'Legacy farmer name' }, clientDb);
  assert.deepEqual(result, { tds_member_id: 5, tds_deductee_name: 'Client 5', tds_pan: 'ABCDE1234F', tds_aadhaar: '123456789012' });
});
test('an explicitly linked Land Purchase Client overrides the farmer default; commissions use the agent', async () => {
  const linked = await resolvePaymentDeductee({ related_member_id: 6 }, 2, null, { memberId: 5 }, clientDb);
  assert.equal(linked.tds_member_id, 6);
  const agent = await resolvePaymentDeductee({ tds_member_id: 6, related_member_id: 6 }, 2, null, { memberId: 5, force: true }, clientDb);
  assert.equal(agent.tds_member_id, 5);
  assert.equal(agent.tds_deductee_name, 'Client 5');
});
test('legacy module names resolve only to unique site Clients', async () => {
  const db = { query: async (sql, args) => sql.startsWith('SELECT id FROM') ? (assert.deepEqual(args, [2, 'Agent']), { rows: [{ id: 5 }] }) : clientDb.query(sql, args) };
  assert.equal((await resolvePaymentDeductee({}, 2, null, { name: 'Agent' }, db)).tds_member_id, 5);
  const ambiguous = { query: async () => ({ rows: [{ id: 5 }, { id: 6 }] }) };
  const result = await resolvePaymentDeductee({}, 2, null, { name: 'Agent' }, ambiguous);
  assert.equal(result.tds_member_id, null); assert.equal(result.tds_deductee_name, 'Agent');
});
test('module autofill never refreshes historical TDS snapshots on a note edit', async () => {
  const original = { tds_amount: 2000, tds_member_id: 5, tds_deductee_name: 'Original Agent', tds_pan: 'ABCDE1234F', tds_aadhaar: '123456789012' };
  const db = { query: async () => { throw new Error('No lookup for existing snapshots'); } };
  const result = await resolvePaymentDeductee({ remarks: 'Proof attached' }, 2, original, { memberId: 6, force: true }, db);
  assert.deepEqual(result, Object.fromEntries(Object.entries(original).filter(([key]) => key !== 'tds_amount')));
});
