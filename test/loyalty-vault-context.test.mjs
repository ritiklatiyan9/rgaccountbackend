import test from 'node:test';
import assert from 'node:assert/strict';
import { loyaltyVaultMiddleware,runLoyaltyVaultAssignment,withLoyaltyVault,vaultInsertColumns,vaultInsertValues,vaultUpdateSet } from '../src/services/loyaltyVaultContext.service.js';
import { withPaymentTds,tdsInsertColumns,tdsInsertValues,tdsUpdateSet } from '../src/services/paymentTds.service.js';
import MasterModel from '../src/models/MasterModel.js';

const request=(body={},headers={})=>({method:'PUT',body,user:{id:9},get:key=>headers[key]});
const run=(req,callback)=>new Promise((resolve,reject)=>loyaltyVaultMiddleware(req,{},error=>error?reject(error):Promise.resolve().then(callback).then(resolve,reject)));
test('native custody capture preserves omitted edits, rejects forged audit fields, and persists multipart header selections',async()=>{
  assert.deepEqual(withLoyaltyVault('expenses',{amount:12,loyalty_vault_assigned_by:99}),{amount:12});
  assert.equal(vaultUpdateSet('expenses'),'');
  const selected=await run(request({}, {'X-Loyalty-Vault-Holder-Type':'member','X-Loyalty-Vault-Holder-ID':'15'}),()=>withPaymentTds('expenses',{amount:12}));
  assert.deepEqual(selected,{amount:12,loyalty_vault_holder_type:'member',loyalty_vault_holder_id:15,loyalty_vault_assigned_by:9});
  await assert.rejects(run(request({}, {'X-Loyalty-Vault-Holder-Type':'none'}),()=>true),error=>error.statusCode===400);
  const cleared=await run(request({loyalty_vault_holder_type:'user',loyalty_vault_holder_id:8},{'X-Loyalty-Vault-Holder-Type':'none','X-Loyalty-Vault-Holder-ID':'none'}),()=>withLoyaltyVault('expenses',{amount:12}));
  assert.equal(cleared.loyalty_vault_holder_id,null);assert.equal(cleared.loyalty_vault_holder_type,null);
  assert.equal(selected.loyalty_vault_assigned_by,9);assert.equal(withLoyaltyVault('expenses',{}).loyalty_vault_holder_type,undefined);
  for(const body of [{loyalty_vault_holder_type:'user'},{loyalty_vault_holder_type:'client',loyalty_vault_holder_id:1},{loyalty_vault_holder_type:'user',loyalty_vault_holder_id:'1; DROP TABLE users'},{loyalty_vault_holder_type:'user',loyalty_vault_holder_id:0}])await assert.rejects(run(request(body),()=>true),error=>error.statusCode===400);
});
test('approval applies saved proposed custody under the active reviewer and existing SQL fragments carry it atomically',async()=>{
  const snapshot=await runLoyaltyVaultAssignment({id:7},{loyalty_vault_holder_type:'user',loyalty_vault_holder_id:3,loyalty_vault_assigned_by:999},async()=>{
    const model=new MasterModel('expenses'),writes=[];
    const db={query:async(sql,args)=>{writes.push({sql,args});return {rows:[{id:10}]};}};
    await model.create({site_id:2,amount:100},db);await model.update(10,{amount:110},db);
    assert.ok(writes.every(write=>write.sql.includes('loyalty_vault_assigned_by')));
    assert.deepEqual(writes[0].args,[2,100,'user',3,7]);assert.deepEqual(writes[1].args,[110,'user',3,7,10]);
    assert.equal(tdsInsertColumns('expenses'),vaultInsertColumns('expenses'));assert.equal(tdsInsertValues('expenses'),vaultInsertValues('expenses'));assert.equal(tdsUpdateSet('expenses'),vaultUpdateSet('expenses'));
    assert.deepEqual(withLoyaltyVault('payment_qrs',{amount:12}),{amount:12});
    return withLoyaltyVault('expenses',{});
  });
  assert.equal(snapshot.loyalty_vault_assigned_by,7);
});
test('concurrent requests retain independent custody selections',async()=>{
  const outputs=await Promise.all([1,2,3].map(id=>run(request({loyalty_vault_holder_type:'user',loyalty_vault_holder_id:id}),async()=>{
    await new Promise(resolve=>setTimeout(resolve,5*(4-id)));
    return withLoyaltyVault('cash_flow_entries',{}).loyalty_vault_holder_id;
  })));
  assert.deepEqual(outputs,[1,2,3]);
});
