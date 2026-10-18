import test from 'node:test';
import assert from 'node:assert/strict';
import pool from '../src/config/db.js';
import expenseSiteAccess from '../src/middlewares/expenseSiteAccess.middleware.js';

const invoke = req => new Promise((resolve,reject) => expenseSiteAccess({body:{},query:{},params:{},...req}, {
  status(code) { this.code=code;return this; }, json(body) { resolve({code:this.code,body}); },
}, error => error ? reject(error) : resolve({next:true})));

test('expense entry boundaries reject malformed ids before cache or model reads', async t => {
  t.mock.method(pool,'query',async()=>{throw Error('Unexpected database access');});
  for (const role of ['admin','sub_admin']) {
    assert.equal((await invoke({user:{id:1,role},params:{id:'9junk'}})).code,400);
    assert.equal((await invoke({user:{id:1,role},query:{site_id:'5.1'}})).code,400);
  }
});

test('a vendor approval resolves the native payment site, even if an expense shares its numeric ID', async t => {
  const calls=[];
  t.mock.method(pool,'query',async(sql,args)=>{
    calls.push({sql,args});
    if (sql.includes('FROM vendor_payments')) return {rows:[{site_id:7}]};
    if (sql.includes('FROM user_sites')) return {rows:[]};
    throw Error('Wrong source queried');
  });
  const denied=await invoke({user:{id:12,role:'sub_admin'},params:{id:'9'},query:{source:'vendor_payment',site_id:'5'}});
  assert.equal(denied.code,403);
  assert.deepEqual(calls[1].args,[12,7]);
});

test('an allowed site membership continues to the existing expense behavior',async t=>{
  t.mock.method(pool,'query',async(sql,args)=>{
    assert.match(sql,/FROM user_sites/);assert.deepEqual(args,[12,'5']);return{rows:[{exists:1}]};
  });
  assert.deepEqual(await invoke({user:{id:12,role:'sub_admin'},query:{site_id:'5'}}),{next:true});
});
