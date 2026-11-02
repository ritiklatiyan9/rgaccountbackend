// Reproducible, isolated PostgreSQL benchmark. This never imports the configured
// database pool for queries: both implementations receive the owned PGlite DB.
import {performance} from 'node:perf_hooks';
import {writeFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {adminWalletCashStates as before} from './fixtures/adminWalletCash.before.mjs';
import * as after from '../../src/services/adminWalletCash.service.js';
import {up as projectionUp} from '../../src/migrations/234_wallet_site_projection.js';

const option=(name,fallback)=>process.argv.find(value=>value.startsWith(`--${name}=`))?.split('=').slice(1).join('=')??fallback;
const rows=Number(option('rows',120000)),sites=Number(option('sites',20)),iterations=Number(option('iterations',7)),concurrency=Number(option('concurrency',4));
const phase=option('phase','both'),output=option('output','docs/benchmarks/wallet-cash-latest.json');
if(!Number.isInteger(rows)||rows<100000||!Number.isInteger(sites)||sites<2||sites>100||!Number.isInteger(iterations)||iterations<3||!Number.isInteger(concurrency)||concurrency<1||concurrency>16) throw Error('Use >=100000 rows, 2–100 sites, >=3 iterations and 1–16 logical concurrent requests');
const pg=new PGlite();
let queries=0;let captured=[];
const query=async(sql,args)=>{
 queries++;captured.push({sql,args});
 const result=args?.length?await pg.query(sql,args):(await pg.exec(sql)).at(-1);
 return {...result,rows:result?.rows||[],rowCount:result?.affectedRows??result?.rows?.length??0};
};
const client={query,release(){}};
const siteIds=Array.from({length:sites},(_,index)=>index+1);
const beforeMany=async()=>{
 const result=new Map();for(const siteId of siteIds)result.set(siteId,await before(1,siteId,client));return result;
};
const afterMany=()=>after.adminWalletCashStatesForSites(1,siteIds,client);
// PGlite owns one PostgreSQL connection. Serialize whole read transactions,
// while logical requests arrive concurrently and include queue wait in latency.
let queue=Promise.resolve();
const snapshot=run=>{
 const current=queue.then(async()=>{await query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');try{const result=await run();await query('COMMIT');return result;}catch(error){await query('ROLLBACK');throw error;}});
 queue=current.catch(()=>{});return current;
};
const stats=values=>{const sorted=[...values].sort((a,b)=>a-b);return {min_ms:+sorted[0].toFixed(3),median_ms:+sorted[Math.floor(sorted.length/2)].toFixed(3),p95_ms:+sorted[Math.min(sorted.length-1,Math.ceil(sorted.length*.95)-1)].toFixed(3),max_ms:+sorted.at(-1).toFixed(3)};};
async function measure(run){
 await snapshot(run);const times=[],counts=[];
 for(let i=0;i<iterations;i++){queries=0;const start=performance.now();await snapshot(run);times.push(performance.now()-start);counts.push(queries);}
 const burst=[];queries=0;const burstStart=performance.now();
 await Promise.all(Array.from({length:concurrency},async()=>{const start=performance.now();await snapshot(run);burst.push(performance.now()-start);}));
 return {...stats(times),samples:times.length,query_count_per_request:counts[0],logical_concurrency:concurrency,burst:{...stats(burst),total_ms:+(performance.now()-burstStart).toFixed(3),query_count:queries}};
}
const normalized=value=>value instanceof Map?[...value].map(([key,item])=>[key,normalized(item)]):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).map(([key,item])=>[key,typeof item==='number'?item.toFixed(2):normalized(item)])):value;
async function explain(call){
 captured=[];await snapshot(call);
 const first=captured.find(row=>/^WITH (?:aligned|selected_sites)/.test(row.sql));
 if(!first)return null;
 const {rows:plans}=await query('EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) '+first.sql,first.args);
 return plans[0]['QUERY PLAN'];
}
try {
 await query(`CREATE TABLE app_schema_migrations(version text PRIMARY KEY);CREATE TABLE users(id integer PRIMARY KEY,name text,role text,organization_id integer,is_active boolean DEFAULT true);
 INSERT INTO users SELECT i,'User '||i,CASE WHEN i=1 THEN 'admin' ELSE 'sub_admin' END,1,true FROM generate_series(1,51)i;
 CREATE TABLE sites(id integer PRIMARY KEY,organization_id integer);INSERT INTO sites SELECT i,1 FROM generate_series(1,${sites})i;
 CREATE TABLE members(id integer PRIMARY KEY,full_name text);
 CREATE TABLE loyalty_vault_entries(id BIGSERIAL PRIMARY KEY,organization_id integer,site_id integer,holder_key text,holder_type text,holder_id integer,amount numeric(15,2),kind text,source_table text,created_at timestamptz DEFAULT '2026-10-01');
 INSERT INTO loyalty_vault_entries(organization_id,site_id,holder_key,holder_type,holder_id,amount,kind,source_table)
 SELECT 1,i,'user:1','user',1,100000,'adjustment','manual_wallet_site_cash_alignment' FROM generate_series(1,${sites})i;
 INSERT INTO loyalty_vault_entries(organization_id,site_id,holder_key,holder_type,holder_id,amount,kind)
 SELECT 1,(i%${sites})+1,'user:'||((i/${sites})%51+1),'user',(i/${sites})%51+1,
 CASE WHEN i%7=0 THEN -((i%97)+1)::numeric/100 ELSE ((i%997)+1)::numeric/100 END,
 CASE WHEN i%7=0 THEN 'transfer_out' WHEN i%11=0 THEN 'transfer_in' ELSE 'credit' END FROM generate_series(1,${rows})i;
 CREATE INDEX cash_wallet_site_holder_balance ON loyalty_vault_entries(organization_id,site_id,holder_key,id);
 CREATE INDEX cash_wallet_history_org_site ON loyalty_vault_entries(organization_id,site_id,id DESC);
 CREATE INDEX loyalty_vault_holder_history ON loyalty_vault_entries(holder_key,id DESC);
 CREATE TABLE ledger_entries(id bigint,site_id integer,entry_date date,bucket text,debit numeric(15,2),credit numeric(15,2));
 INSERT INTO ledger_entries SELECT i,(i%${sites})+1,'2026-10-01',CASE WHEN (i/${sites})%5=0 THEN 'bank' ELSE 'cash' END,
 CASE WHEN i%13=0 THEN 1.17 ELSE 0 END,CASE WHEN i%13<>0 THEN ((i%997)+1)::numeric/100 ELSE 0 END FROM generate_series(1,${rows})i;
 CREATE INDEX bench_ledger_site_date ON ledger_entries(site_id,entry_date);
 CREATE TABLE imprest_ledger(id BIGSERIAL,user_id integer,site_id integer,amount numeric(15,2),created_at timestamptz DEFAULT '2026-10-01');
 INSERT INTO imprest_ledger(user_id,site_id,amount) SELECT (i%50)+2,(i%${sites})+1,CASE WHEN i%7=0 THEN -0.99 ELSE 1.01 END FROM generate_series(1,20000)i;
 CREATE INDEX bench_float_site_user ON imprest_ledger(site_id,user_id,created_at);
 CREATE TABLE imprest_allocations(site_id integer,amount numeric(15,2),status text,from_own_float boolean,created_at timestamptz DEFAULT '2026-10-01');
 INSERT INTO imprest_allocations(site_id,amount,status,from_own_float) SELECT (i%${sites})+1,2.01,CASE WHEN i%4=0 THEN 'PENDING_RECEIPT' ELSE 'RECEIVED' END,i%3=0 FROM generate_series(1,10000)i;
 CREATE INDEX bench_alloc_site_status ON imprest_allocations(site_id,status,created_at);
 CREATE TABLE imprest_site_debit_reservations(site_id integer,amount numeric(15,2));INSERT INTO imprest_site_debit_reservations SELECT (i%${sites})+1,0.57 FROM generate_series(1,500)i;
 CREATE INDEX bench_debit_site ON imprest_site_debit_reservations(site_id);
 ANALYZE;`);
 await projectionUp({query,connect:async()=>client});
 const result={baseline_commit:'6624715',runtime:{node:process.version,platform:process.platform,arch:process.arch,database:'PGlite embedded PostgreSQL; one connection, no network'},dataset:{wallet_entries:rows+sites,financial_entries:rows,imprest_entries:20000,allocations:10000,sites,holders:51},limits:['Owned in-memory synthetic PostgreSQL data only; no hosted load test','Financial view cost is represented by posted ledger rows, not every production source-table join','Logical concurrent arrivals use one owned PostgreSQL connection and serialized whole snapshots; not a multi-client contention benchmark','Latency excludes HTTP, authentication, browser rendering and remote network; p95 targets are not production claims']};
 if(phase!=='after')result.before={single_site:await measure(()=>before(1,1,client)),all_sites:await measure(beforeMany),plan:await explain(()=>before(1,1,client))};
 if(phase!=='before'&&after.adminWalletCashStatesForSites){
  const old=normalized(await snapshot(beforeMany)),fresh=normalized(await snapshot(afterMany));
  if(JSON.stringify(old)!==JSON.stringify(fresh))throw Error('Before/after cash states differ; refusing benchmark claim');
  result.after={single_site:await measure(()=>after.adminWalletCashStates(1,1,client)),all_sites:await measure(afterMany),plan:await explain(afterMany)};
  result.correctness='All sites and holder cash states equal before/after, normalized decimal metadata types';
 }
 await writeFile(output,JSON.stringify(result,null,2)+'\n');
 console.log(JSON.stringify({output,...Object.fromEntries(['before','after'].filter(key=>result[key]).map(key=>[key,{single_site:result[key].single_site,all_sites:result[key].all_sites}]))}));
}finally{await pg.close();}
