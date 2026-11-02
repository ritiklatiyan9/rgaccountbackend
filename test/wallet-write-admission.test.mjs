import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createWalletWriteAdmission,walletWriteAdmissionStats } from '../src/services/walletWriteAdmission.service.js';
import { createVaultTransfer } from '../src/services/loyaltyVault.service.js';
import { createWalletImprestTransfer } from '../src/services/walletImprestTransfer.service.js';
import errorMiddleware from '../src/middlewares/error.middleware.js';

const ordinary=()=>({site_id:10,to_holder_id:2,amount:'1.01',idempotency_key:randomUUID()});
const imprest=()=>({site_id:10,from_user_id:1,to_user_id:2,amount:'1.01',idempotency_key:randomUUID()});
const isBusy=error=>error.code==='WALLET_WRITE_BUSY'&&error.statusCode===503&&error.retryAfterSeconds===2;

test('bounded write queue rejects overload, expires waiters and recovers every admission slot',async()=>{
  const admission=createWalletWriteAdmission({limit:1,maxPending:1,queueTimeoutMs:20});
  const first=await admission.acquire();
  const waiting=admission.acquire();
  assert.deepEqual(admission.stats(),{active:1,pending:1,limit:1,maxPending:1});
  await assert.rejects(admission.acquire(),isBusy);
  await assert.rejects(waiting,isBusy);
  assert.equal(admission.stats().pending,0);
  first();first();
  assert.equal(admission.stats().active,0,'duplicate releases cannot release another transaction');
  const recovered=await admission.acquire();recovered();
  assert.equal(admission.stats().active,0);
});

test('write admission preserves FIFO order without granting the same permit twice',async()=>{
  const admission=createWalletWriteAdmission({limit:1,maxPending:2,queueTimeoutMs:1000});
  const first=await admission.acquire();
  const order=[];
  const second=admission.acquire().then(release=>{order.push(2);return release;});
  const third=admission.acquire().then(release=>{order.push(3);return release;});
  first();
  const releaseSecond=await second;
  first();
  assert.deepEqual(order,[2]);assert.equal(admission.stats().pending,1);
  releaseSecond();
  const releaseThird=await third;releaseThird();
  assert.deepEqual(order,[2,3]);assert.equal(admission.stats().active,0);
});

test('normal and imprest writers share admission before pool checkout, leaving room for another API',async()=>{
  let unblock;
  const gate=new Promise(resolve=>{unblock=resolve;});
  let checkedOut=0,peak=0,connections=0;
  const database={options:{max:4},connect:async()=>{
    connections+=1;checkedOut+=1;peak=Math.max(peak,checkedOut);
    const client=new EventEmitter();
    client.query=async sql=>{if(sql.startsWith('SELECT id, name, role'))await gate;return {rows:[]};};
    client.release=()=>{checkedOut-=1;};return client;
  }};
  const writes=Array.from({length:12},(_,index)=>(index%2
    ?createVaultTransfer({id:1},ordinary(),database)
    :createWalletImprestTransfer({id:1},imprest(),database)).catch(error=>error));
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(connections,2,'waiting writes hold no PostgreSQL clients');
  assert.deepEqual(walletWriteAdmissionStats(database),{active:2,pending:10,limit:2,maxPending:32});
  const unrelated=await database.connect();
  assert.equal(checkedOut,3,'the four-client pool retains capacity for login/another API');
  unrelated.release();
  unblock();
  const results=await Promise.all(writes);
  assert.ok(results.every(error=>error.statusCode===403));
  assert.equal(peak,3);assert.equal(checkedOut,0);
  assert.equal(walletWriteAdmissionStats(database).active,0);assert.equal(walletWriteAdmissionStats(database).pending,0);
});

test('failed connection checkout returns write admission for both transfer services',async()=>{
  for(const create of [createVaultTransfer,createWalletImprestTransfer]) {
    const failure=new Error('Pool checkout failed');
    let attempts=0;
    const database={connect:async()=>{
      if(!attempts++)throw failure;
      return {query:async()=>({rows:[]}),release(){}};
    }};
    const data=create===createVaultTransfer?ordinary():imprest();
    await assert.rejects(create({id:1},data,database),error=>error===failure);
    assert.equal(walletWriteAdmissionStats(database).active,0);
    await assert.rejects(create({id:1},data,database),error=>error.statusCode===403);
    assert.equal(walletWriteAdmissionStats(database).active,0);
  }
});

test('admission overload returns an actionable retry response without an error-log storm',async()=>{
  const admission=createWalletWriteAdmission({limit:1,maxPending:0});
  const release=await admission.acquire();
  let failure;
  try {await admission.acquire();}catch(error){failure=error;}
  release();
  const response={headers:{},set(name,value){this.headers[name]=value;return this;},status(value){this.statusCode=value;return this;},json(value){this.body=value;return this;}};
  const originalError=console.error;let errors=0;
  console.error=()=>{errors+=1;};
  try {errorMiddleware(failure,{},response,()=>{});}finally{console.error=originalError;}
  assert.equal(response.statusCode,503);assert.equal(response.headers['Retry-After'],'2');
  assert.equal(response.body.code,'WALLET_WRITE_BUSY');assert.equal(response.body.retry_after_seconds,2);
  assert.match(response.body.message,/same request key/);assert.equal(errors,0);
});
