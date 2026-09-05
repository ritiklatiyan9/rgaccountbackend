import test from 'node:test';
import assert from 'node:assert/strict';
import {asId,validDate,versionOf,normalizeEntries,editSource} from '../src/services/transactionTransfer.validation.js';
const source={date:'2026-09-05',amount:100,direction:'debit',particular:'Party',payment_mode:'CASH',mode:'cash',cheque_no:null,cheque_status:null,status:'approved',approved_by:2,approved_at:'2026-09-05',customer_signature_url:'signature',bank_account_id:10,raw:{}};
test('strict ids, calendar dates and bounded unique batches',()=>{
  for(const id of ['1abc','1.1',0,-1,'1e3',null,{},'9007199254740992'])assert.throws(()=>asId(id));
  assert.equal(asId('222'),222);
  for(const date of ['2026-02-30','2026-13-01','2025-02-29','1899-12-31','2026-9-5','2101-01-01'])assert.throws(()=>validDate(date));
  assert.equal(validDate('2024-02-29'),'2024-02-29');
  assert.equal(validDate(new Date(2026,8,5)),'2026-09-05');
  for(const entries of [[],Array(101).fill({source_type:'expense',source_id:1}),[{source_type:'expense',source_id:1},{source_type:'expense',source_id:'1'}]])assert.throws(()=>normalizeEntries({entries}));
  assert.equal(normalizeEntries({entries:[{source_type:'expense',source_id:1},{source_type:'plot_payment',source_id:1}]}).length,2);
});
test('money rejects coercion, negative amounts, rounding loss and unsupported edits',()=>{
  for(const amount of ['10abc','1e3','Infinity','NaN',Infinity,NaN,'0','-1','1.005',{},null,'9999999999999'])assert.throws(()=>editSource(source,{amount}));
  for(const edits of [{site_id:7},{status:'approved'},{approved_by:4},{created_by:3},{particular:''},{direction:'refund'}])assert.throws(()=>editSource(source,edits));
  assert.equal(editSource(source,{amount:'120.50'}).amount,120.5);
});
test('reclassification resets approvals and signatures without mutating original evidence',()=>{
  const result=editSource(source,{remarks:'Corrected category'});
  assert.equal(result.status,'pending');assert.equal(result.approved_by,null);assert.equal(result.customer_signature_url,null);
  assert.equal(source.status,'approved');assert.equal(source.customer_signature_url,'signature');assert.equal(result.bank_account_id,null);
});
test('cheque details are required and financial edits reset clearance',()=>{
  assert.throws(()=>editSource(source,{payment_mode:'CHEQUE'}));
  const cheque={...source,payment_mode:'CHEQUE',mode:'cheque',cheque_no:'1234',cheque_status:'CLEARED'};
  assert.equal(editSource(cheque,{}).cheque_status,'CLEARED');
  assert.equal(editSource(cheque,{amount:200}).cheque_status,'PENDING');
  assert.equal(editSource(cheque,{date:'2026-09-06'}).cheque_status,'PENDING');
  assert.equal(editSource(cheque,{payment_mode:'CASH'}).cheque_status,null);
  assert.throws(()=>editSource({...source,raw:{payment_mode:'SPLIT'}},{}));
});
test('version covers edits even if updated_at has not changed',()=>{
  const row={id:1,updated_at:'2026-09-05',amount:'100',row_version:'10'};
  assert.notEqual(versionOf(row),versionOf({...row,amount:'101'}));
  assert.notEqual(versionOf(row),versionOf({...row,row_version:'11'}));
});
