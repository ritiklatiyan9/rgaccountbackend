// Read-only business-data diagnostic. Empty session-local allocation tables
// allow pre-deployment planning without installing a schema or posting money.
import fs from 'node:fs/promises';
import pool from '../../src/config/db.js';
import {transferLedgerBalanceSql,transferEligibilitySql} from '../../src/services/cashflowTransfer.service.js';

const db=await pool.connect();
try {
 await db.query('BEGIN');
 await db.query("SET LOCAL statement_timeout='30s'; SET LOCAL lock_timeout='3s'");
 const installed=(await db.query("SELECT to_regclass('cashflow_transfer_allocations') IS NOT NULL AS installed")).rows[0].installed;
 if(!installed) {
  await db.query(`CREATE TEMP TABLE cashflow_transfer_allocations(source_entry_id integer,amount numeric(15,2));
   CREATE INDEX ON cashflow_transfer_allocations(source_entry_id);
   CREATE TEMP VIEW cashflow_transfer_legacy_sources AS
    SELECT e.id FROM cash_flow_entries e JOIN transaction_money_transfers t ON
      (t.source_type='personal_ledger' AND t.source_record_id=e.id) OR
      (e.source_id=t.source_record_id AND e.source_module=transfer_owner_table(t.source_type))
    UNION ALL SELECT e.id FROM cash_flow_entries e JOIN plot_money_transfers t ON e.source_module='plot_payments' AND e.source_id=t.source_payment_id;`);
 }
 const candidate=(await db.query(`SELECT m.id,s.organization_id,count(e.id)::int AS entry_count FROM cash_flow_months m
  JOIN sites s ON s.id=m.site_id JOIN cash_flow_entries e ON e.cash_flow_month_id=m.id
  WHERE m.ledger_type='person' GROUP BY m.id,s.organization_id ORDER BY count(e.id) DESC LIMIT 1`)).rows[0];
 if(!candidate) throw Error('No ledger available for read-only query planning.');
 const ids=(await db.query('SELECT id FROM cash_flow_entries WHERE cash_flow_month_id=$1 ORDER BY id LIMIT 200',[candidate.id])).rows.map(row=>row.id);
 const plans={};
 for(const [name,sql,args] of [
  ['balance',transferLedgerBalanceSql,[[candidate.id],candidate.organization_id,true,0]],
  ['eligibility',transferEligibilitySql,[candidate.id,ids,0,200]],
 ]) {
  const started=performance.now();
  plans[name]={wall_ms:performance.now()-started,plan:(await db.query('EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) '+sql,args)).rows[0]['QUERY PLAN'][0]};
  plans[name].wall_ms=performance.now()-started;
 }
 const report={captured_at:new Date().toISOString(),business_rows_changed:0,transfer_schema_installed:installed,
  workload:{ledger_entry_count:candidate.entry_count,requested_receipts:ids.length},
  limitations:installed?'Existing production accounting view and indexes.':'Existing production accounting view and indexes; allocation tables are empty session-local tables because the feature is not installed yet.',plans};
 await fs.mkdir('benchmarks',{recursive:true});
 await fs.writeFile('benchmarks/cashflow-transfers-live-plan.json',JSON.stringify(report,null,2)+'\n');
 console.log(JSON.stringify({business_rows_changed:0,workload:report.workload,queries:Object.fromEntries(Object.entries(plans).map(([key,value])=>[key,{execution_ms:value.plan['Execution Time'],wall_ms:value.wall_ms}]))}));
} finally {
 await db.query('ROLLBACK').catch(()=>{});
 db.release();await pool.end();
}
