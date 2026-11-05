import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createCashflowTransfer as create,updateTransferSettings} from '../src/services/cashflowTransfer.service.js';
import {fixturePair,fixtureLedger,ledgerFunds,organizationFunds} from './fixtures/cashflow-money-transfers.mjs';
import {isolatedPostgresFixture} from './fixtures/cashflow-postgres-isolation.mjs';

test('independent PostgreSQL connections serialize competing transfers and duplicate request races',
  {skip:process.env.CASHFLOW_PG_TEST!=='1',timeout:120000},async t=>{
  const {db,close}=await isolatedPostgresFixture();
  try {
    await updateTransferSettings({id:1},{approval_limit:'100000'},db);
    await t.test('two different transfers against one source cannot spend more than its funds',async()=>{
      const {request,source,destination}=await fixturePair(db);
      const other=await fixtureLedger(db,{site:11});
      const before=await organizationFunds(db);
      const blocker=await db.connect();
      await blocker.query('BEGIN');await blocker.query('SELECT id FROM cash_flow_months WHERE id=$1 FOR UPDATE',[source.id]);
      const requests=[{...request,amount:'80'},{...request,destination_ledger_id:other.id,amount:'80',idempotency_key:randomUUID()}];
      const attempts=requests.map(data=>create({id:2},data,db));
      const pending=Promise.allSettled(attempts);
      // Both independent clients reach the balance mutex before it is released.
      await new Promise(resolve=>setTimeout(resolve,150));
      await blocker.query('COMMIT');blocker.release();
      const results=await pending;
      // Remote database RTT may exhaust the production five-second lock wait.
      // Retry only the documented busy outcome after the contenders settle,
      // retaining the exact request key; the refreshed balance must then deny it.
      for(let index=0;index<results.length;index++) if(results[index].status==='rejected'&&results[index].reason.code==='TRANSFER_BUSY') {
        results[index]=(await Promise.allSettled([create({id:2},requests[index],db)]))[0];
      }
      assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
      const failed=results.find(r=>r.status==='rejected').reason;
      assert.ok(['AMOUNT_EXCEEDS_SELECTION','INSUFFICIENT_SOURCE_BALANCE'].includes(failed.code),failed.message);
      assert.equal(await ledgerFunds(db,source.id),'20.00');
      assert.equal(Number(await ledgerFunds(db,destination.id))+Number(await ledgerFunds(db,other.id)),80);
      assert.equal(await organizationFunds(db),before);
    });
    await t.test('parallel duplicate keys produce exactly one pair and one audit row',async()=>{
      const {request,destination}=await fixturePair(db,{site:11,credits:['0.01']});
      const burst=await Promise.allSettled(Array.from({length:8},()=>create({id:2},request,db)));
      const results=[];
      for(const attempt of burst) {
        if(attempt.status==='fulfilled') results.push(attempt.value);
        else {
          assert.equal(attempt.reason.code,'TRANSFER_BUSY','only the documented lock timeout may ask for a retry');
          results.push(await create({id:2},request,db));
        }
      }
      assert.equal(new Set(results.map(r=>r.transfer.id)).size,1);assert.equal(results.filter(r=>!r.replayed).length,1);
      const id=results[0].transfer.id;
      assert.equal(await ledgerFunds(db,destination.id),'0.01');
      assert.equal((await db.query('SELECT count(*)::int AS n FROM cash_flow_entries WHERE money_transfer_id=$1',[id])).rows[0].n,2);
      assert.equal((await db.query('SELECT count(*)::int AS n FROM cashflow_transfer_audit WHERE transfer_id=$1',[id])).rows[0].n,1);
    });
    await t.test('an ordinary debit holding the parent lock is visible in the transfer recheck',async()=>{
      const {request,source,destination}=await fixturePair(db);
      const writer=await db.connect();await writer.query('BEGIN');
      await writer.query(`INSERT INTO cash_flow_entries(cash_flow_month_id,site_id,particular,debit,credit,cash_type,status,created_by)
        VALUES($1,$2,'Concurrent ordinary payment',95,0,'cash','approved',1)`,[source.id,source.site_id]);
      const transferring=create({id:2},{...request,amount:'10'},db);
      await new Promise(resolve=>setTimeout(resolve,150));await writer.query('COMMIT');writer.release();
      await assert.rejects(transferring,error=>error.code==='INSUFFICIENT_SOURCE_BALANCE');
      assert.equal(await ledgerFunds(db,source.id),'5.00');assert.equal(await ledgerFunds(db,destination.id),'0.00');
    });
  } finally {await close();}
});
