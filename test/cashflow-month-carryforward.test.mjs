import test from 'node:test';
import assert from 'node:assert/strict';
import pool from '../src/config/db.js';
import { createMonth } from '../src/controllers/cashflow.controller.js';
import { createCashflowTransfer, updateTransferSettings } from '../src/services/cashflowTransfer.service.js';
import { pgliteFixture, fixturePair, ledgerFunds } from './fixtures/cashflow-money-transfers.mjs';
import { isolatedPostgresFixture } from './fixtures/cashflow-postgres-isolation.mjs';

async function controllerPair(db) {
  const pair=await fixturePair(db);
  // createMonth stores ledger names in uppercase; fixture helpers also serve
  // lower-level tests and deliberately impose no UI normalization.
  pair.source.ledger_name=pair.source.ledger_name.toUpperCase();
  await db.query('UPDATE cash_flow_months SET ledger_name=$2 WHERE id=$1',[pair.source.id,pair.source.ledger_name]);
  return pair;
}

function requestMonth(source, overrides={}) {
  return new Promise((resolve,reject) => {
    const response = { statusCode:200, status(code) { this.statusCode=code;return this; },
      json(body) { resolve({status:this.statusCode,body});return this; } };
    createMonth({user:{id:1},body:{site_id:source.site_id,ledger_name:source.ledger_name,ledger_type:source.ledger_type,
      month:source.month===12?1:source.month+1,year:source.year+(source.month===12?1:0),...overrides}},response,reject);
  });
}

test('month carry-forward includes committed transfers, preserves explicit opening, and rolls back failed creation', async t => {
  const {db,close}=await pgliteFixture();
  const original={query:pool.query,connect:pool.connect};
  pool.query=(...args)=>db.query(...args);pool.connect=()=>db.connect();
  try {
    await updateTransferSettings({id:1},{approval_limit:'1000'},db);
    const {source,request}=await controllerPair(db);
    await createCashflowTransfer({id:1},{...request,amount:'40'},db);
    await t.test('automatic opening uses the posted closing and duplicate creation returns conflict',async()=>{
      const result=await requestMonth(source);
      assert.equal(result.status,201);assert.equal(Number(result.body.month.opening_balance),60);
      assert.equal(await ledgerFunds(db,source.id),'60.00');
      const duplicate=await requestMonth(source);
      assert.equal(duplicate.status,409);
      assert.equal((await db.query('SELECT count(*)::int AS n FROM cash_flow_months WHERE site_id=$1 AND ledger_name=$2',[source.site_id,source.ledger_name])).rows[0].n,2);
    });
    await t.test('an explicit zero opening is not replaced by the previous closing',async()=>{
      const pair=await controllerPair(db);
      const result=await requestMonth(pair.source,{opening_balance:'0'});
      assert.equal(result.status,201);assert.equal(Number(result.body.month.opening_balance),0);
    });
    await t.test('commit failure returns no success and rolls back the inserted month',async()=>{
      const pair=await controllerPair(db);
      let discarded=false,released=false;
      pool.connect=async()=>{
        const client=await db.connect();
        return {query:async(sql,args)=>{
          if(sql==='COMMIT') throw new Error('Injected commit rejection');
          if(sql==='ROLLBACK') discarded=true;
          return client.query(sql,args);
        },release:(error)=>{released=true;client.release(error);}};
      };
      await assert.rejects(requestMonth(pair.source),/Injected commit rejection/);
      assert.ok(discarded);assert.ok(released);
      assert.equal((await db.query('SELECT count(*)::int AS n FROM cash_flow_months WHERE site_id=$1 AND ledger_name=$2',[pair.source.site_id,pair.source.ledger_name])).rows[0].n,1);
      pool.connect=()=>db.connect();
    });
  } finally {pool.query=original.query;pool.connect=original.connect;await close();}
});

test('concurrent month creation waits for a transfer before reading its closing balance',
  {skip:process.env.CASHFLOW_PG_TEST!=='1',timeout:120000},async()=>{
  const {db,close}=await isolatedPostgresFixture();
  const original={query:pool.query,connect:pool.connect};
  let releaseTransfer;
  const gate=new Promise(resolve=>{releaseTransfer=resolve;});
  let announceTransfer,announceMonth;
  const transferHasLocks=new Promise(resolve=>{announceTransfer=resolve;});
  const monthStarted=new Promise(resolve=>{announceMonth=resolve;});
  let transferPending,monthPending;
  try {
    await updateTransferSettings({id:1},{approval_limit:'1000'},db);
    const {source,request}=await controllerPair(db);
    const transferDb={connect:async()=>{
      const client=await db.connect();
      return {query:async(sql,args)=>{
        if(sql.startsWith('INSERT INTO cashflow_transfers(')) {announceTransfer();await gate;}
        return client.query(sql,args);
      },release:(error)=>client.release(error)};
    }};
    const monthQuery=(client,sql,args)=>{
      if(sql.includes('pg_advisory_xact_lock')||sql.startsWith('WITH dup')) announceMonth();
      return client.query(sql,args);
    };
    pool.query=(sql,args)=>monthQuery(db,sql,args);
    pool.connect=async()=>{
      const client=await db.connect();
      return {query:(sql,args)=>monthQuery(client,sql,args),release:(error)=>client.release(error)};
    };
    // Pause after the transfer owns its financial locks. The old controller
    // computed 100 before blocking in its INSERT trigger, forwarding stale funds.
    transferPending=createCashflowTransfer({id:1},{...request,amount:'40'},transferDb);
    await transferHasLocks;
    monthPending=requestMonth(source).then(value=>({value}),error=>({error}));
    await monthStarted;
    await new Promise(resolve=>setTimeout(resolve,100));
    releaseTransfer();
    await transferPending;
    const settled=await monthPending;
    let result=settled.value;
    if(settled.error) {
      assert.ok(['55P03','TRANSFER_BUSY'].includes(settled.error.code),settled.error.message);
      // A slow remote writer may legitimately exceed the production lock wait.
      // The original failed request must leave no month; retry then derives the
      // committed closing, never the snapshot taken before the transfer.
      assert.equal((await db.query('SELECT count(*)::int AS n FROM cash_flow_months WHERE site_id=$1 AND ledger_name=$2',[source.site_id,source.ledger_name])).rows[0].n,1);
      result=await requestMonth(source);
    }
    assert.equal(result.status,201);
    assert.equal(Number(result.body.month.opening_balance),60);
    assert.equal(await ledgerFunds(db,source.id),'60.00');
  } finally {
    releaseTransfer();await Promise.allSettled([transferPending,monthPending].filter(Boolean));
    pool.query=original.query;pool.connect=original.connect;await close();
  }
});
