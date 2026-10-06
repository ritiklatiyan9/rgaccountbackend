import assert from 'node:assert/strict';
import test from 'node:test';
import pool from '../src/config/db.js';
import { createExpenseRequest, confirmReceipt } from '../src/controllers/imprest.controller.js';
import { imprestAllocationModel, imprestExpenseRequestModel } from '../src/models/Imprest.model.js';
import errorMiddleware from '../src/middlewares/error.middleware.js';

const invoke = (handler, body={}, extra={}) => new Promise((resolve,reject)=> {
  let status=200;
  handler({body,params:{id:51},user:{id:2,role:'sub_admin'},imprestSiteId:10,...extra},
    {status(v){status=v;return this;},json(data){resolve({status,data});}},reject);
});

for (const available of [0,-100,49]) {
  test(`refill and receipt reject insufficient cash (${available}) without posting money`,async t=> {
    const queries=[];
    const db={ async query(sql) {
      queries.push(sql);
      if(sql.startsWith('WITH ledger AS')) return {rows:[{cash_balance:available+100,bank_balance:999999,
        imprest_held:100,pending_imprest_reservations:0,distributable_balance:available}]};
      if(sql.includes('SELECT name, role')) return {rows:[{name:'Admin',role:'admin'}]};
      if(sql.includes('CASE')) return {rows:[{amount:0}]};
      assert.match(sql.trim(),/^(BEGIN|ROLLBACK|SELECT)\b/);
      return {rows:[]};
    },release(){} };
    t.mock.method(pool,'connect',async()=>db);
    t.mock.method(pool,'query',async()=>{throw Error('Unexpected query outside transaction');});
    t.mock.method(imprestAllocationModel,'findByIdForUpdate',async()=>({id:51,site_id:10,admin_id:1,sub_admin_id:2,
      amount:50,status:'PENDING_RECEIPT',from_own_float:true}));
    for(const [handler,body] of [[createExpenseRequest,{site_id:10,amount:50,reason:'Refill',request_type:'IMPREST'}],
      [confirmReceipt,{confirmation_remark:'Received'}]]) {
      const result=await invoke(handler,body);
      assert.equal(result.data.code,'INSUFFICIENT_SITE_BALANCE');
      assert.ok([400,409].includes(result.status));
      assert.equal(queries.at(-1),'ROLLBACK');
      assert.ok(!queries.includes('COMMIT'));
    }
  });
}

test('a request within the cash balance commits without reserving or crediting cash',async t=> {
  const queries=[];
  const db={async query(sql){queries.push(sql);return {rows:sql.startsWith('WITH ledger AS')?[{
    cash_balance:100,bank_balance:0,imprest_held:0,pending_imprest_reservations:0,distributable_balance:100}]:[]};},release(){}};
  t.mock.method(pool,'connect',async()=>db);
  t.mock.method(imprestExpenseRequestModel,'create',async(data,connection)=>{assert.equal(connection,db);return {id:1,...data};});
  const result=await invoke(createExpenseRequest,{site_id:10,amount:100,reason:'Refill',request_type:'IMPREST'});
  assert.equal(result.status,201);
  assert.equal(result.data.request.status,'PENDING');
  assert.equal(queries.at(-1),'COMMIT');
  assert.ok(!queries.some(sql=>/INSERT.*imprest_(ledger|allocations)/i.test(sql)));
});

test('database rejection is returned as a useful funding error',t=> {
  t.mock.method(console,'error',()=>{});
  let status; let response;
  errorMiddleware({constraint:'imprest_site_cash_funding',code:'23514',message:'Insufficient site cash.',
    detail:JSON.stringify({available:0,required:100,shortfall:100})},{},
    {status(v){status=v;return this;},json(v){response=v;}},()=>{});
  assert.equal(status,409);
  assert.equal(response.code,'INSUFFICIENT_SITE_BALANCE');
  assert.equal(response.available,0);
  assert.equal(response.shortfall,100);
});
