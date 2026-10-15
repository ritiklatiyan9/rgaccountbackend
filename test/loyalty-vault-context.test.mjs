import test from 'node:test';
import assert from 'node:assert/strict';
import { loyaltyVaultMiddleware,runLoyaltyVaultAssignment,withLoyaltyVault,vaultInsertColumns,vaultInsertValues,vaultUpdateSet,runLoyaltyVaultSourceMaker,LOYALTY_VAULT_SOURCE_TABLES } from '../src/services/loyaltyVaultContext.service.js';
import { withPaymentTds,tdsInsertColumns,tdsInsertValues,tdsUpdateSet } from '../src/services/paymentTds.service.js';
import MasterModel from '../src/models/MasterModel.js';
const request=(body={},headers={},user={id:9,role:'sub_admin'},method='POST')=>({method,body,user,get:key=>headers[key]});
const run=(req,callback)=>new Promise((resolve,reject)=>loyaltyVaultMiddleware(req,{},error=>error?reject(error):Promise.resolve().then(callback).then(resolve,reject)));
const pair=id=>({loyalty_vault_holder_type:'user',loyalty_vault_holder_id:id});
const own=id=>({...pair(id),loyalty_vault_assigned_by:id});

test('new native sources default to the authenticated maker even without collector fields',async()=>{
  assert.deepEqual(withLoyaltyVault('expenses',{amount:12,loyalty_vault_assigned_by:99}),{amount:12});
  assert.equal(vaultUpdateSet('expenses'),'');
  await run(request(),async()=>{
    for(const table of LOYALTY_VAULT_SOURCE_TABLES){
      const writes=[],db={query:async(sql,args)=>{writes.push({sql,args});return {rows:[{id:10}]};}};
      await new MasterModel(table).create({amount:12,created_by:999},db);
      assert.deepEqual(writes[0].args,[12,9,'user',9,9],table);
      assert.ok(writes[0].sql.includes('loyalty_vault_assigned_by'),table);
      assert.deepEqual(withLoyaltyVault(table,{amount:12},'create'),{amount:12,created_by:9,...own(9)});
      assert.equal(tdsInsertColumns(table),vaultInsertColumns(table));assert.equal(tdsInsertValues(table),vaultInsertValues(table));
    }
    assert.deepEqual(withLoyaltyVault('payment_qrs',{amount:12},'create'),{amount:12});
  });
});
test('all roles can select only themselves for a new receipt through body, aliases or multipart headers',async()=>{
  for(const role of ['sub_admin','admin','super_admin']){
    for(const body of [pair(8),{loyalty_vault_holder_type:'member',loyalty_vault_holder_id:9},{loyalty_vault_holder_type:null,loyalty_vault_holder_id:null},{cash_deposit_holder_type:'user',cash_deposit_holder_id:8}]){
      await assert.rejects(run(request(body,{}, {id:9,role}),()=>withLoyaltyVault('expenses',{amount:12},'create')),error=>error.statusCode===400 && /locked/.test(error.message));
    }
    for(const prefix of ['X-Cash-Deposit','X-Loyalty-Vault']){
      await assert.rejects(run(request({}, {[`${prefix}-Holder-Type`]:'user',[`${prefix}-Holder-ID`]:'8'}, {id:9,role}),()=>vaultInsertValues('expenses')),error=>error.statusCode===400 && /locked/.test(error.message));
      assert.deepEqual(await run(request({}, {[`${prefix}-Holder-Type`]:'user',[`${prefix}-Holder-ID`]:'9'}, {id:9,role}),()=>withLoyaltyVault('expenses',{},'create')),{created_by:9,...own(9)});
    }
  }
});
test('late authentication and parsed multipart body determine the current account',async()=>{
  const req=request();delete req.user;
  await run(req,()=>{
    req.user={id:7};req.body={cash_deposit_holder_type:'user',cash_deposit_holder_id:'7'};
    assert.deepEqual(withLoyaltyVault('expenses',{},'create'),{created_by:7,...own(7)});
    req.body.cash_deposit_holder_id='8';assert.throws(()=>withLoyaltyVault('expenses',{},'create'),{statusCode:400});
  });
  await assert.rejects(run({...request(),user:undefined},()=>vaultInsertValues('expenses')),error=>error.statusCode===401);
});
test('malformed or conflicting body and header collector values cannot be hidden by aliases',async()=>{
  for(const body of [{loyalty_vault_holder_type:'user'},{loyalty_vault_holder_type:'client',loyalty_vault_holder_id:1},{loyalty_vault_holder_type:'user',loyalty_vault_holder_id:'1; DROP TABLE users'},{loyalty_vault_holder_type:'user',loyalty_vault_holder_id:0},{cash_deposit_holder_type:'user'}])await assert.rejects(run(request(body),()=>true),error=>error.statusCode===400);
  await assert.rejects(run(request({}, {'X-Loyalty-Vault-Holder-Type':'none'}),()=>true),error=>error.statusCode===400);
  await assert.rejects(run(request({...pair(8),cash_deposit_holder_type:'user',cash_deposit_holder_id:9}),()=>true),/Conflicting/);
  await assert.rejects(run(request(pair(8),{'X-Cash-Deposit-Holder-Type':'user','X-Cash-Deposit-Holder-ID':'9'}),()=>true),/Conflicting/);
});
test('financial edits and approvals do not assign the original receipt to the editor or reviewer',async()=>{
  await run(request({}, {}, {id:9},'PUT'),async()=>{
    assert.deepEqual(withPaymentTds('expenses',{amount:12}),{amount:12});
    assert.equal(vaultUpdateSet('expenses'),'');assert.equal(tdsUpdateSet('expenses'),'');
    await runLoyaltyVaultAssignment({id:7},{amount:20},async()=>{
      assert.deepEqual(withLoyaltyVault('expenses',{amount:20}),{amount:20});
      assert.deepEqual(withLoyaltyVault('expenses',{amount:20},'create'),{amount:20});
      assert.equal(vaultUpdateSet('expenses'),'');
    });
  });
  // Saved pairs reach the DB unchanged, where 211 compares them to OLD. The
  // reviewer is never stamped as the original assignment actor.
  const proposed=await runLoyaltyVaultAssignment({id:7},{...pair(3),loyalty_vault_assigned_by:999},()=>withLoyaltyVault('expenses',{amount:20}));
  assert.deepEqual(proposed,{amount:20,...pair(3)});
  assert.deepEqual(await run(request(pair(3),{}, {id:7},'PUT'),()=>withLoyaltyVault('expenses',{amount:20})),{amount:20,...pair(3)});
});
test('concurrent requests retain their own authenticated collector',async()=>{
  const outputs=await Promise.all([1,2,3].map(id=>run(request({}, {},{id}),async()=>{
    await new Promise(resolve=>setTimeout(resolve,5*(4-id)));
    return withLoyaltyVault('cash_flow_entries',{},'create').loyalty_vault_holder_id;
  })));
  assert.deepEqual(outputs,[1,2,3]);
});

test('materializing a stored approved request preserves its maker and debit owner',async()=>{
  await run(request({}, {},{id:9,role:'admin'}),async()=>{
    const db={query:async(sql,args)=>{assert.deepEqual(args,[20000,3]);assert.ok(!sql.includes('loyalty_vault'));return {rows:[]};}};
    await runLoyaltyVaultSourceMaker(3,()=>new MasterModel('expenses').create({debit:20000,created_by:3,...pair(9)},db));
  });
});
