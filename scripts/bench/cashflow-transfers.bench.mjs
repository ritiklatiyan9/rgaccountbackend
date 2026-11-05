import {performance} from 'node:perf_hooks';
import {writeFile,mkdir} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {pgliteFixture} from '../../test/fixtures/cashflow-money-transfers.mjs';
import {isolatedPostgresFixture} from '../../test/fixtures/cashflow-postgres-isolation.mjs';
import {transferEligibility,transferDestinations,listCashflowTransfers,transferEligibilitySql,transferLedgerBalanceSql} from '../../src/services/cashflowTransfer.service.js';

const real=process.env.CASHFLOW_PG_TEST==='1',iterations=Math.max(10,Math.min(100,Number(process.env.BENCH_ITERATIONS)||40));
const fixture=await (real?isolatedPostgresFixture():pgliteFixture());
const {db}=fixture;
const stats=values=>{
  const sorted=[...values].sort((a,b)=>a-b),at=p=>Number(sorted[Math.max(0,Math.min(sorted.length-1,Math.ceil(sorted.length*p)-1))].toFixed(2));
  return {samples:values.length,min_ms:at(0),p50_ms:at(.5),p95_ms:at(.95),max_ms:at(1)};
};
try {
  // Synthetic records exist exclusively inside PGlite or the guarded temporary
  // PostgreSQL namespace. The cardinality matches the inspected installation.
  await db.query(`INSERT INTO cash_flow_months(site_id,month,year,ledger_name,ledger_type,created_by)
    SELECT CASE WHEN n%2=0 THEN 10 ELSE 11 END,11,2026,'Benchmark ledger '||n,'person',1 FROM generate_series(1,539) n;
    INSERT INTO cash_flow_entries(cash_flow_month_id,site_id,particular,credit,debit,cash_type,status,created_by)
    SELECT m.id,m.site_id,'Synthetic benchmark receipt',100,0,'cash','approved',1
    FROM generate_series(1,28240) n JOIN cash_flow_months m ON m.id=(n-1)%539+1;`);
  const seed=await db.connect();
  try {
    await seed.query('BEGIN');
    await seed.query(`INSERT INTO cashflow_transfers(id,reference,organization_id,source_site_id,source_ledger_id,destination_site_id,destination_ledger_id,
      amount,transfer_type,source_transaction_ids,initiated_by,approval_limit,idempotency_key,request_hash,
      source_balance_before,source_balance_after,destination_balance_before,destination_balance_after,created_at)
      SELECT md5('fixture-transfer-'||m.id)::uuid,'CFT-FIXTURE-'||m.id,1,m.site_id,m.id,d.site_id,d.id,
        1,'same_site',ARRAY[(SELECT min(id) FROM cash_flow_entries WHERE cash_flow_month_id=m.id)],2,1000,md5('fixture-key-'||m.id)::uuid,'fixture-only',
        sb.balance,sb.balance-1,dt.balance,dt.balance+1,now()+m.id*interval '1 microsecond'
      FROM cash_flow_months m JOIN cash_flow_months d ON d.id=m.id+100
      CROSS JOIN LATERAL(SELECT sum(credit-debit) AS balance FROM cash_flow_entries WHERE cash_flow_month_id=m.id) sb
      CROSS JOIN LATERAL(SELECT sum(credit-debit) AS balance FROM cash_flow_entries WHERE cash_flow_month_id=d.id) dt
      WHERE m.id<=100;
      INSERT INTO cashflow_transfer_allocations SELECT id,source_transaction_ids[1],amount,'cash' FROM cashflow_transfers;
      INSERT INTO cash_flow_entries(cash_flow_month_id,site_id,particular,debit,credit,cash_type,status,created_by,source_module,money_transfer_id,money_transfer_leg)
      SELECT source_ledger_id,source_site_id,'Synthetic transfer out',amount,0,'cash','approved',initiated_by,'cashflow_transfers',id,'debit' FROM cashflow_transfers
      UNION ALL SELECT destination_ledger_id,destination_site_id,'Synthetic transfer in',0,amount,'cash','approved',initiated_by,'cashflow_transfers',id,'credit' FROM cashflow_transfers;
      INSERT INTO cashflow_transfer_audit(transfer_id,actor_id,event,payload) SELECT id,initiated_by,'completed','{}'::jsonb FROM cashflow_transfers;`);
    await seed.query('COMMIT');
  } catch(error) {await seed.query('ROLLBACK');throw error;} finally {seed.release();}
  await db.query('ANALYZE cash_flow_entries; ANALYZE cash_flow_months; ANALYZE cashflow_transfers; ANALYZE cashflow_transfer_allocations;');
  const ids=(await db.query('SELECT id FROM cash_flow_entries WHERE cash_flow_month_id=2 ORDER BY id LIMIT 50')).rows.map(row=>row.id);
  const sqlCases={ledger_balance:[transferLedgerBalanceSql,[[2,102],1,true,1]],eligibility:[transferEligibilitySql,[2,ids,0,200]],
    history:['SELECT id FROM cashflow_transfers WHERE organization_id=$1 ORDER BY created_at DESC,id DESC LIMIT $2',[1,31]]};
  const plans={};
  for(const [name,[sql,params]] of Object.entries(sqlCases)) plans[name]=(await db.query('EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) '+sql,params)).rows[0]['QUERY PLAN'];
  const cases={eligibility:()=>transferEligibility({id:2},{source_ledger_id:2,entry_ids:ids.join(',')},db),
    destinations:()=>transferDestinations({id:2},{source_ledger_id:2,site_id:11,limit:30,q:'Benchmark'},db),
    history:()=>listCashflowTransfers({id:2},{site_id:10,limit:30},db)};
  const reads={};
  for(const [name,run] of Object.entries(cases)) {
    for(let i=0;i<3;i++) await run();
    const times=[];
    for(let i=0;i<iterations;i++) {const before=performance.now();await run();times.push(performance.now()-before);}
    reads[name]=stats(times);
  }
  const report={engine:real?'PostgreSQL direct endpoint, isolated schema':'PGlite PostgreSQL WASM, in-memory isolated database',
    workload:{ledgers:539,original_entries:28240,transfer_headers:100,transfer_postings:200,service_read_concurrency:1,iterations_per_read:iterations},
    limitations:'Service reads include database round trips but exclude HTTP/auth middleware. Fixture ledger_entries preserves posting, source exclusions and balance shape; it is not the complete production view. PGlite measurements do not prove production latency or concurrent locking.',
    reads,plans};
  const output=resolve(process.env.BENCH_OUTPUT||`benchmarks/cashflow-transfers-${real?'postgres':'pglite'}.json`);
  await mkdir(dirname(output),{recursive:true});await writeFile(output,JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({output,workload:report.workload,reads},null,2));
} finally {await fixture.close();}
