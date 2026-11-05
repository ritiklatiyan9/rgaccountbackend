// Observational audit only. Never prints request rows, parameter values or names.
import pool from '../../src/config/db.js';
import {listRequestHistory} from '../../src/controllers/approval.controller.js';
import {performance} from 'node:perf_hooks';
import {mkdir,writeFile} from 'node:fs/promises';
const client=await pool.connect(),original=pool.query,profiles=[];let scenario;
try{
  await client.query('BEGIN READ ONLY');await client.query("SET LOCAL statement_timeout='15s'");
  const {rows:[site]}=await client.query(`SELECT s.id,s.organization_id FROM sites s LEFT JOIN expenses e ON e.site_id=s.id
    GROUP BY s.id ORDER BY count(e.id) DESC,s.id LIMIT 1`);
  if(!site)throw new Error('No site available');
  pool.query=async(input,params)=>{
    const sql=typeof input==='string'?input:input.text,values=typeof input==='string'?params:input.values,start=performance.now();
    if(!sql.startsWith('WITH source_')){const result=await client.query(sql,values);profiles.push({case:scenario,kind:sql.includes('information_schema')?'schema':sql.includes('to_regclass')?'relations':'authorization',client_ms:performance.now()-start});return result;}
    const {rows}=await client.query(`EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON) ${sql}`,values),plan=rows[0]['QUERY PLAN'][0],nodes=[];
    const visit=node=>{nodes.push(node);(node.Plans||[]).forEach(visit);};visit(plan.Plan);
    const scans=new Map();for(const node of nodes.filter(node=>node['Node Type']==='Seq Scan')){
      const key=node['Relation Name'],previous=scans.get(key)||{table:key,rows_removed:0,loops:0};
      previous.rows_removed+=(node['Rows Removed by Filter']||0)*(node['Actual Loops']||1);previous.loops+=node['Actual Loops']||0;scans.set(key,previous);
    }
    profiles.push({case:scenario,kind:'history',client_ms:performance.now()-start,execution_ms:plan['Execution Time'],planning_ms:plan['Planning Time'],
      sort_spills:nodes.filter(node=>node['Sort Space Type']==='Disk').length,shared_hits:plan.Plan['Shared Hit Blocks']||0,shared_reads:plan.Plan['Shared Read Blocks']||0,
      index_scans:nodes.filter(node=>/Index.*Scan/.test(node['Node Type'])).length,seq_scans:[...scans.values()]});
    return {rows:[{entries:[],total:0}]};
  };
  const common={view:'summary',pagination:'cursor',include_total:'true'};
  for(const[name,query]of[['first_page',common],['deep_page',{view:'summary',page:'1000'}],['status',{...common,status:'rejected'}],
    ['date_range',{...common,from:'2026-01-01',to:'2026-11-05'}],['search',{...common,q:'payment'}],['cursor_no_count',{...common,include_total:'false'}]]){
    scenario=name;await new Promise((resolve,reject)=>listRequestHistory({user:{id:0,role:'admin',organization_id:site.organization_id},query:{site_id:String(site.id),...query}},
      {set(){return this;},status(code){reject(new Error(`Plan response ${code}`));return this;},json(){resolve();}},reject));
  }
  const ping=[];for(let i=0;i<7;i++){const start=performance.now();await client.query('SELECT 1');ping.push(performance.now()-start);}
  const tables=['cash_flow_entries','expenses','day_book','plot_payments','edit_requests','seek_permissions','loyalty_vault_transfers'];
  const {rows:statistics}=await client.query(`SELECT relname,n_live_tup,n_dead_tup,last_autovacuum,last_autoanalyze,last_analyze,
    pg_total_relation_size(relid) AS bytes FROM pg_stat_user_tables WHERE relname=ANY($1) ORDER BY n_live_tup DESC`,[tables]);
  const {rows:settings}=await client.query("SELECT name,setting,unit FROM pg_settings WHERE name=ANY($1)",[['autovacuum','autovacuum_vacuum_scale_factor','autovacuum_analyze_scale_factor','statement_timeout','max_connections']]);
  const {rows:indexes}=await client.query(`SELECT count(*)::int AS total,count(*) FILTER(WHERE i.indisvalid)::int AS valid
    FROM pg_class c JOIN pg_index i ON i.indexrelid=c.oid WHERE c.relname LIKE 'request_history_%'`);
  const sorted=[...ping].sort((a,b)=>a-b);
  const report={phase:'after',scope:'read-only observational plans on busiest expense site; planning actor only; no financial rows returned',
    profiles,slowest_five:[...profiles].filter(row=>row.kind==='history').sort((a,b)=>b.execution_ms-a.execution_ms).slice(0,5),
    round_trip:{samples:ping.length,p50_ms:+sorted[3].toFixed(2),p95_ms:+sorted.at(-1).toFixed(2)},statistics,settings,indexes:indexes[0],redis_configured:Boolean(process.env.REDIS_URL)};
  await mkdir('benchmarks',{recursive:true});await writeFile('benchmarks/history-db-after.json',JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({profiles:profiles.filter(row=>row.kind==='history').map(({seq_scans,...row})=>row),round_trip:report.round_trip,indexes:report.indexes},null,2));
}finally{pool.query=original;await client.query('ROLLBACK');client.release();await pool.end();}
