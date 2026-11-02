import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { walletReadQuery, walletReadTransaction, createWalletReadLimiter } from '../src/services/walletRead.service.js';
import { pendingVaultTotals } from '../src/services/loyaltyVaultTransactions.service.js';

test('a timed-out wallet read rolls back and releases its connection for login and other requests', async () => {
  const timeout = Object.assign(new Error('statement timeout'), { code: '57014' });
  let readOnly = false, configured = false, rolledBack = false, released = false;
  const db = { connect: async () => ({
    async query(sql, params) {
      if (sql.startsWith('BEGIN READ ONLY;')) {readOnly=true;configured=/SET LOCAL statement_timeout = '\d+ms'$/.test(sql);}
      else if (sql === 'ROLLBACK') rolledBack = true;
      else if (sql === 'SELECT expensive_wallet_read') throw timeout;
      return { rows: [] };
    },
    release() { released = true; },
  }) };
  await assert.rejects(walletReadQuery(db, 'SELECT expensive_wallet_read'), error => error === timeout);
  assert.ok(readOnly && configured && rolledBack && released);
});

test('snapshot setup sends one bounded trusted command and preserves repeatable-read isolation',async t=>{
 const previous=process.env.WALLET_READ_TIMEOUT_MS;
 t.after(()=>{if(previous===undefined)delete process.env.WALLET_READ_TIMEOUT_MS;else process.env.WALLET_READ_TIMEOUT_MS=previous;});
 process.env.WALLET_READ_TIMEOUT_MS="1'; SELECT pg_sleep(99);--";
 const calls=[];
 const db={connect:async()=>({query:async sql=>{calls.push(sql);return{rows:[1]};},release(){}})};
 await walletReadTransaction(db,client=>client.query('SELECT 1'),{repeatableRead:true});
 assert.deepEqual(calls,["BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SET LOCAL statement_timeout = '8000ms'",'SELECT 1','COMMIT']);
 process.env.WALLET_READ_TIMEOUT_MS='50000';calls.length=0;
 await walletReadQuery(db,'SELECT 1');
 assert.equal(calls[0],"BEGIN READ ONLY; SET LOCAL statement_timeout = '30000ms'");
});

test('a failed rollback discards the connection instead of returning an open transaction to the pool', async () => {
  const failure = new Error('read failed'), cleanup = new Error('connection lost');
  let discarded;
  const db = { connect: async () => ({
    async query(sql) {
      if (sql === 'SELECT failure') throw failure;
      if (sql === 'ROLLBACK') throw cleanup;
      return { rows: [] };
    },
    release(error) { discarded = error; },
  }) };
  await assert.rejects(walletReadQuery(db, 'SELECT failure'), error => error === failure);
  assert.equal(discarded, cleanup);
});

test('summary and holder requests share only in-flight totals with the same tenant and visibility', async () => {
  let resolve, queries = 0;
  const gate = new Promise(done => { resolve = done; });
  const db = { connect: async () => ({
    async query(sql, params) {
      if (!sql.startsWith('WITH wallet_mode')) return { rows: [] };
      queries += 1;
      await gate;
      return { rows: [{ organization_id: params[0], actor_id: params[2] }] };
    },
    release() {},
  }) };
  const actor = { id: 1, organization_id: 7, role: 'sub_admin' };
  const first = pendingVaultTotals(actor, db);
  const duplicate = pendingVaultTotals({ ...actor }, db);
  const other = pendingVaultTotals({ ...actor, organization_id: 8 }, db);
  assert.strictEqual(first, duplicate);
  resolve();
  assert.equal((await first)[0].organization_id, 7);
  assert.equal((await other)[0].organization_id, 8);
  assert.equal(queries, 2);
  await pendingVaultTotals(actor, db);
  assert.equal(queries, 3, 'completed totals must be reread after transactions or approvals');
});
test('pending totals reuse the caller read snapshot without another pool checkout or transaction', async () => {
  const queries = [];
  const client = { release() { throw new Error('The outer snapshot owns release'); },
    async query(sql, params) { queries.push({ sql, params }); return { rows: [{ holder_id: 7, pending_credit: '10.15' }] }; } };
  const result = await pendingVaultTotals({ id: 7, organization_id: 1, role: 'sub_admin' }, client, null, 5);
  assert.equal(result[0].pending_credit, '10.15'); assert.equal(queries.length, 2);
  assert.ok(queries[0].sql.includes('AS consolidated'));
  assert.ok(queries[1].sql.startsWith('WITH wallet_mode'));
  assert.deepEqual(queries[1].params, [1, false, 7, 5]);
});

test('consolidated pending totals stop before planning native JSON sources',async()=>{
 let queries=0;
 const client={release(){},query:async(sql)=>{queries++;assert.ok(sql.includes('AS consolidated'));return{rows:[{consolidated:true}]};}};
 assert.deepEqual(await pendingVaultTotals({id:7,organization_id:1,role:'admin'},client,null,5),[]);
 assert.equal(queries,1,'the consolidated policy cannot produce pending custody; do not build its fourteen legacy branches');
});

test('wallet readers reserve capacity for login and reject overload instead of building an unbounded queue', async () => {
  const limiter = createWalletReadLimiter({ limit: 2, maxPending: 1 });
  const first = await limiter.acquire(), second = await limiter.acquire();
  const queued = limiter.acquire();
  await assert.rejects(limiter.acquire(), error => error.code === 'WALLET_READ_BUSY');
  first();
  const third = await queued;
  second(); third();
  const recovered = await limiter.acquire(); recovered();
});

test('queued wallet reads time out without leaking their place in the queue', async () => {
  const limiter = createWalletReadLimiter({ limit: 1, maxPending: 1, queueTimeoutMs: 5 });
  const active = await limiter.acquire();
  await assert.rejects(limiter.acquire(), error => error.code === 'WALLET_READ_BUSY');
  active();
  const recovered = await limiter.acquire(); recovered();
});

test('failed connection checkout releases the wallet admission slot', async () => {
  let connects = 0;
  const db = { options: { max: 3 }, connect: async () => {
    connects += 1;
    if (connects === 1) throw new Error('connection failed');
    return { query: async () => ({ rows: [1] }), release() {} };
  } };
  await assert.rejects(walletReadQuery(db, 'SELECT 1'), /connection failed/);
  assert.deepEqual((await walletReadQuery(db, 'SELECT 1')).rows, [1]);
});

test('an active socket error rejects the read and discards its client without stopping the reader', async()=>{
 const failure=new Error('Connection terminated unexpectedly');let released;
 const client=Object.assign(new EventEmitter(),{query:async sql=>{if(sql==='SELECT disconnected'){client.emit('error',failure);throw failure;}return {rows:[]};},release:error=>{released=error;}});
 const db={connect:async()=>client};
 await assert.rejects(walletReadQuery(db,'SELECT disconnected'),error=>error===failure);
 assert.equal(released,failure);assert.equal(client.listenerCount('error'),0);
 const recovered={connect:async()=>({query:async()=>({rows:[1]}),release(){}})};
 assert.deepEqual((await walletReadQuery(recovered,'SELECT 1')).rows,[1]);
});
