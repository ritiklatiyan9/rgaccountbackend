// Reproducible loopback HTTP benchmark on disposable PostgreSQL-compatible data.
// Authentication is a fixture token; these timings exclude hosted authentication.
import http from 'node:http';
import { performance } from 'node:perf_hooks';
import { mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import express from 'express';
import { PGlite } from '@electric-sql/pglite';

const phase = process.env.HISTORY_BENCH_PHASE || 'after';
if(!['before','after'].includes(phase))throw new Error('HISTORY_BENCH_PHASE must be before or after');
const modulePath = phase === 'before' ? fileURLToPath(new URL('../../benchmarks/baseline/requestHistory.service.mjs',import.meta.url))
  : fileURLToPath(new URL('../../src/services/requestHistory.service.js', import.meta.url));
const { createRequestHistoryReader, requestHistoryOptions } = await import(pathToFileURL(modulePath));
const db = new PGlite();
let dataQueries=0;
const query=db.query.bind(db);db.query=(sql,values)=>{if(typeof sql==='string'&&sql.startsWith('WITH source_'))dataQueries++;return query(sql,values);};
const perSource = Number(process.env.HISTORY_BENCH_ROWS || 10000);
const samples = Number(process.env.HISTORY_BENCH_SAMPLES || 20);
const sources = [['expense','expenses'],['cash_flow_entry','cash_flow_entries'],['plot_payment','plot_payments'],['plot_commission_payment','plot_commission_payments']];
const percentile = (values,p) => [...values].sort((a,b)=>a-b)[Math.min(values.length-1,Math.ceil(values.length*p)-1)];
const sourceSql = (source,table) => `SELECT t.*,'${source}' AS source,'Fixture'::text AS site_name,'Fixture party'::text AS entity_name,'Payment'::text AS entity_type FROM ${table} t WHERE site_id=$1`;
let server;
try {
  await db.exec(`CREATE TABLE users(id int PRIMARY KEY,name text,email text);INSERT INTO users VALUES(7,'Fixture reviewer','fixture@test');`);
  for (const [,table] of sources) await db.exec(`CREATE TABLE ${table}(id int PRIMARY KEY,site_id int,status text,
    approved_at timestamptz,updated_at timestamptz,created_at timestamptz,date date,approved_by int,created_by int,
    assigned_admin_id int,amount numeric,source_module text,notes text,original_data jsonb,voucher_url text);
    INSERT INTO ${table} SELECT n,1,CASE WHEN n%3=0 THEN 'rejected' ELSE 'approved' END,
      '2025-01-01'::timestamptz+n*interval '1 microsecond','2025-01-01','2024-01-01','2025-01-01',7,7,7,1234.25,NULL,
      CASE WHEN n%100=0 THEN 'Invoice 50%_ search' ELSE 'Payment request' END,
      jsonb_build_object('audit_snapshot',repeat('Original request payload ',80)),NULL FROM generate_series(1,${perSource}) n;
    CREATE INDEX archive_${table} ON ${table}(site_id,lower(status),id DESC)
      WHERE lower(status) IN ('approved','accepted','received','returned','rejected','declined');ANALYZE ${table};`);
  if (phase === 'after') {
    const { installFixtureHistoryOrderIndexes } = await import('./history-benchmark-indexes.mjs');
    await installFixtureHistoryOrderIndexes(db,sources.map(([,table])=>table));
  }
  const app = express();
  if (phase === 'after') {
    const { historyTransport } = await import('../../src/middlewares/historyTransport.middleware.js');
    app.use(historyTransport);
  }
  app.get('/history',async(req,res,next)=>{
    if(req.headers.authorization!=='Bearer history-fixture')return res.sendStatus(401);
    try {
      const options=requestHistoryOptions({...req.query,site_id:'1'});
      options.authorizationScope='fixture-user-7';
      const reader=createRequestHistoryReader(db,options);
      for(const[source,table]of sources)reader.add(sourceSql(source,table),[1]);
      const result=await reader.read();
      res.json({entries:result.rows,total:result.total,has_more:result.hasMore??options.page*options.pageSize<result.total,
        ...(result.nextCursor?{next_cursor:result.nextCursor}:{}),...(result.snapshot?{snapshot:result.snapshot}:{})});
    }catch(error){next(error);}
  });
  app.use((error,_req,res,_next)=>res.status(error.statusCode||500).json({error:error.message}));
  server=http.createServer(app);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const port=server.address().port;
  const request=query=>new Promise((resolve,reject)=>{
    const start=performance.now();
    const req=http.get({hostname:'127.0.0.1',port,agent:false,path:`/history?${new URLSearchParams(query)}`,
      headers:{Authorization:'Bearer history-fixture','Accept-Encoding':'gzip'},timeout:15000},res=>{
      const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>{
        const bytes=Buffer.concat(chunks),decoded=res.headers['content-encoding']==='gzip'?gunzipSync(bytes):bytes;
        const body=JSON.parse(decoded);
        if(res.statusCode!==200)return reject(new Error(`HTTP ${res.statusCode}: ${body.error}`));
        resolve({ms:performance.now()-start,wire_bytes:bytes.length,json_bytes:decoded.length,body});
      });
    });req.on('error',reject);req.on('timeout',()=>req.destroy(new Error('Benchmark request timeout')));
  });
  const cases=[['first_page',{}],['deep_page',{page:'1000'}],['literal_search',{q:'50%_'}]];
  if(phase==='after'){
    const first=await request({pagination:'cursor',view:'summary',include_total:'false'});
    const { decodeHistoryCursor,encodeHistoryCursor }=await import('../../src/services/requestHistoryCursor.js');
    const payload=decodeHistoryCursor(first.body.next_cursor);
    // Boundary immediately before legacy page 1000 in this deterministic fixture.
    const boundaryRank=999*20-1,n=perSource-Math.floor(boundaryRank/sources.length);
    const orderedSources=[...sources].map(([source])=>source).sort();
    const source=orderedSources[boundaryRank%sources.length];
    const timestamp=`2025-01-01T00:00:00.${String(n).padStart(6,'0')}+00:00`;
    const after=encodeHistoryCursor({...payload,key:{time:timestamp,source,id:String(n)}});
    cases[0][1]={pagination:'cursor',view:'summary',include_total:'false'};
    cases[1][1]={pagination:'cursor',view:'summary',include_total:'false',after};
    cases[2][1]={pagination:'cursor',view:'summary',include_total:'false',q:'50%_'};
  }
  const results=[];
  for(const[name,query]of cases){
    for(let i=0;i<3;i++)await request(query);
    const sequential=[];
    const initialQueries=dataQueries;
    for(let i=0;i<samples;i++)sequential.push(await request(query));
    const concurrent=[];
    const sequentialQueries=dataQueries-initialQueries,burstStart=dataQueries;
    for(let i=0;i<4;i++)concurrent.push(...await Promise.all(Array.from({length:5},()=>request(query))));
    const describe=rows=>({p50_ms:+percentile(rows.map(row=>row.ms),.50).toFixed(2),p95_ms:+percentile(rows.map(row=>row.ms),.95).toFixed(2),
      p99_ms:+percentile(rows.map(row=>row.ms),.99).toFixed(2),wire_bytes:rows[0].wire_bytes,json_bytes:rows[0].json_bytes});
    results.push({case:name,samples,concurrency:5,exact_count_requested:phase==='before'||query.include_total!=='false',
      sequential:{...describe(sequential),data_queries:sequentialQueries},
      concurrent:{...describe(concurrent),data_queries:dataQueries-burstStart}});
  }
  const report={phase,fixture_rows:perSource*sources.length,page_size:20,auth:'fixture token; hosted auth excluded',engine:'PGlite, disposable fixture',results};
  await mkdir('benchmarks',{recursive:true});await writeFile(`benchmarks/history-${phase}.json`,JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report,null,2));
}finally{if(server)await new Promise(resolve=>server.close(resolve));await db.close();}
