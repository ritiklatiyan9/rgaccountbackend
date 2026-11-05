import test from 'node:test';
import assert from 'node:assert/strict';
import {runHistoryQuery} from '../src/services/requestHistoryQuery.js';
import pg from 'pg';

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

test('native history reads have a bounded driver deadline and expose safe retryable errors',async()=>{
  let config;class FixturePool extends pg.Pool{query(value){config=value;throw new Error('Query read timeout');}}
  const db=new FixturePool();
  await assert.rejects(runHistoryQuery(db,'SELECT expensive()',[],'scope'),error=>error.code==='HISTORY_QUERY_TIMEOUT'&&error.statusCode===503);
  assert.equal(config.query_timeout,5000);assert.equal(config.text,'SELECT expensive()');
  await db.end();
});
