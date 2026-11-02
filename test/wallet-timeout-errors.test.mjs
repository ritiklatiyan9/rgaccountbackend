import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import errorMiddleware from '../src/middlewares/error.middleware.js';
import { createVaultTransfer,resolveVaultTransfer } from '../src/services/loyaltyVault.service.js';
import { createWalletImprestTransfer,resolveWalletImprestTransfer } from '../src/services/walletImprestTransfer.service.js';
import { walletWriteAdmissionStats } from '../src/services/walletWriteAdmission.service.js';

const response=()=>({headers:{},set(name,value){this.headers[name]=value;return this;},status(value){this.statusCode=value;return this;},json(value){this.body=value;return this;}});
function render(error,request) {
  const result=response(),original=console.error;
  console.error=()=>{};
  try {errorMiddleware(error,request,result,()=>{});}finally{console.error=original;}
  return result;
}

test('only wallet route statement/lock timeouts return safe retry guidance without mutating the database error',()=>{
  for(const code of ['57014','55P03'])for(const path of ['/wallet/transfers','/wallet/imprest-transfers/id/accept','/loyalty-vault/transfers/id/accept']) {
    const error=Object.freeze(Object.assign(new Error('Internal SQL and private lock details'),{code}));
    const result=render(error,{method:'POST',originalUrl:`${path}?site_id=10`});
    assert.equal(result.statusCode,503);assert.equal(result.headers['Retry-After'],'2');
    assert.equal(result.body.code,'WALLET_DATABASE_BUSY');assert.equal(result.body.database_code,code);
    assert.equal(result.body.retry_after_seconds,2);assert.match(result.body.message,/same request key/);
    assert.ok(!JSON.stringify(result.body).includes('Internal SQL'));
    assert.equal(error.code,code);assert.equal(error.message,'Internal SQL and private lock details');assert.equal(error.statusCode,undefined);
  }
});

test('wallet reads get retry guidance without requiring a nonexistent mutation key',()=>{
  const result=render(Object.assign(new Error('statement timeout'),{code:'57014'}),{method:'GET',baseUrl:'/wallet',path:'/workspace'});
  assert.equal(result.statusCode,503);assert.equal(result.headers['Retry-After'],'2');
  assert.match(result.body.message,/retry/i);assert.ok(!/request key/.test(result.body.message));
});

test('read admission overload preserves its actionable message and retry header',()=>{
  const error=Object.freeze(Object.assign(new Error('Cash Wallet is busy. Please retry in a few seconds.'),{code:'WALLET_READ_BUSY',statusCode:503}));
  const result=render(error,{method:'GET',originalUrl:'/wallet/workspace'});
  assert.equal(result.statusCode,503);assert.equal(result.headers['Retry-After'],'2');
  assert.equal(result.body.code,error.code);assert.equal(result.body.message,error.message);
  assert.ok(!/request key/.test(result.body.message));
});

test('unrelated routes preserve their existing timeout statuses and route boundaries cannot be spoofed',()=>{
  for(const path of ['/auth/login','/expenses','/wallet-history','/other/wallet/transfers','/imprest/wallet-transfers'])for(const code of ['57014','55P03']) {
    const result=render(Object.assign(new Error('existing database failure'),{code}),{method:'POST',originalUrl:path,path:'/wallet/transfers'});
    assert.equal(result.statusCode,code==='57014'?503:500);
    assert.equal(result.body.code,code==='57014'?'DATABASE_UNAVAILABLE':'55P03');
    assert.equal(result.headers['Retry-After'],code==='57014'?'5':undefined);
    assert.ok(!/same request key/.test(result.body.message));
  }
});

test('financial conflicts, authentication failures and other SQL errors keep their wallet semantics',()=>{
  const request={method:'POST',originalUrl:'/wallet/transfers'};
  const funds=render(Object.assign(new Error('Insufficient cash wallet balance'),{code:'23514',constraint:'loyalty_vault_holder_funds'}),request);
  assert.equal(funds.statusCode,409);assert.equal(funds.body.message,'Insufficient cash wallet balance');assert.equal(funds.headers['Retry-After'],undefined);
  const auth=render(Object.assign(new Error('Session revoked'),{statusCode:401,code:'UNAUTHORIZED'}),request);
  assert.equal(auth.statusCode,401);assert.equal(auth.body.message,'Session revoked');
  const sql=render(Object.assign(new Error('Internal syntax error'),{code:'42601'}),request);
  assert.equal(sql.statusCode,500);assert.equal(sql.body.code,'42601');assert.equal(sql.headers['Retry-After'],undefined);
});

const operations=[
  ['wallet request',db=>createVaultTransfer({id:1},{site_id:10,to_holder_id:2,amount:'1.01',idempotency_key:randomUUID()},db)],
  ['wallet decision',db=>resolveVaultTransfer({id:1},randomUUID(),'accept',{site_id:10},db)],
  ['imprest request',db=>createWalletImprestTransfer({id:1},{site_id:10,from_user_id:1,to_user_id:2,amount:'1.01',idempotency_key:randomUUID()},db)],
  ['imprest decision',db=>resolveWalletImprestTransfer({id:1},randomUUID(),'accept',{site_id:10},db)],
];
for(const [label,run] of operations)for(const code of ['57014','55P03'])test(`${label} rolls back ${code} and preserves the exact error identity`,async()=>{
  const failure=Object.freeze(Object.assign(new Error('Timed out database operation'),{code}));
  const client=new EventEmitter(),statements=[];let released='not released';
  client.query=async sql=>{statements.push(sql);if(sql.startsWith('SELECT id, name, role'))throw failure;return {rows:[]};};
  client.release=error=>{released=error;};
  const database={connect:async()=>client};
  await assert.rejects(run(database),error=>error===failure);
  assert.ok(statements.includes('ROLLBACK'));assert.ok(!statements.includes('COMMIT'));
  assert.equal(released,undefined,'successful rollback preserves the healthy pool client');
  assert.equal(client.listenerCount('error'),0);assert.equal(walletWriteAdmissionStats(database).active,0);
  assert.equal(failure.code,code);assert.equal(failure.statusCode,undefined);
});
