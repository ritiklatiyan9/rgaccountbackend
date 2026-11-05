import test from 'node:test';
import assert from 'node:assert/strict';
import {runHistoryQuery,historyReadQueueStats} from '../src/services/requestHistoryQuery.js';
import pg from 'pg';
import {clearCacheByPrefixes} from '../src/config/cache.js';

test('identical in-flight reads share work only within one authorization scope and never retain completed data',async()=>{
  let calls=0,finish;const db={query(){calls++;return new Promise(resolve=>{finish=resolve;});}};
  const first=runHistoryQuery(db,'SELECT 1',[],'user-a');const second=runHistoryQuery(db,'SELECT 1',[],'user-a');
  await new Promise(setImmediate);assert.equal(calls,1);
  finish({rows:[{nested:{value:1}}],_parsers:[()=>{}]});const[a,b]=await Promise.all([first,second]);
  a.rows[0].nested.value=2;assert.equal(b.rows[0].nested.value,1);
  const next=runHistoryQuery(db,'SELECT 1',[],'user-a');await new Promise(setImmediate);assert.equal(calls,2);finish({rows:[{nested:{value:3}}]});await next;
  let count=0;const isolated={query:async()=>{count++;return{rows:[]};}};
  await Promise.all([runHistoryQuery(isolated,'SELECT 1',[],'user-a'),runHistoryQuery(isolated,'SELECT 1',[],'user-b')]);assert.equal(count,2);
});

test('mutations and explicit refreshes never join work that started before the write',async()=>{
  const resolvers=[];let calls=0;const db={query(){calls++;return new Promise(resolve=>resolvers.push(resolve));}};
  const before=runHistoryQuery(db,'SELECT history',[],'same-user');await new Promise(setImmediate);
  await clearCacheByPrefixes(['approvals|']);
  const after=runHistoryQuery(db,'SELECT history',[],'same-user');await new Promise(setImmediate);
  assert.equal(calls,2);resolvers[0]({rows:[{version:'before'}]});resolvers[1]({rows:[{version:'after'}]});
  assert.equal((await before).rows[0].version,'before');assert.equal((await after).rows[0].version,'after');
  const normal=runHistoryQuery(db,'SELECT history',[],'same-user');await new Promise(setImmediate);
  const fresh=runHistoryQuery(db,'SELECT history',[],'same-user',{fresh:true});await new Promise(setImmediate);
  assert.equal(calls,4);resolvers[2]({rows:[]});resolvers[3]({rows:[]});await Promise.all([normal,fresh]);
});

test('native history reads have a bounded driver deadline and expose safe retryable errors',async()=>{
  let config;class FixturePool extends pg.Pool{query(value){config=value;throw new Error('Query read timeout');}}
  const db=new FixturePool();
  await assert.rejects(runHistoryQuery(db,'SELECT expensive()',[],'scope'),error=>error.code==='HISTORY_QUERY_TIMEOUT'&&error.statusCode===503);
  assert.equal(config.query_timeout,5000);assert.equal(config.text,'SELECT expensive()');
  await db.end();
});

test('unrelated history reads respect the global database concurrency budget and release queued work after errors',async()=>{
  const {concurrency}=historyReadQueueStats();let running=0,maximum=0;
  const db={async query(sql){running++;maximum=Math.max(maximum,running);
    try{await new Promise(resolve=>setTimeout(resolve,5));if(sql==='fail')throw new Error('fixture failure');return {rows:[]};}
    finally{running--;}}};
  const results=await Promise.allSettled(Array.from({length:concurrency+4},(_,index)=>runHistoryQuery(db,index===0?'fail':'SELECT 1',[],`queued-${index}`)));
  assert.equal(results.filter(result=>result.status==='rejected').length,1);
  assert.equal(maximum,concurrency);assert.equal(historyReadQueueStats().active,0);assert.equal(historyReadQueueStats().queued,0);
});
