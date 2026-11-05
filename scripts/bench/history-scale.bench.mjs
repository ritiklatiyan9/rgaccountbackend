import {PGlite} from '@electric-sql/pglite';
import {performance} from 'node:perf_hooks';
import {mkdir,writeFile} from 'node:fs/promises';
import {createRequestHistoryReader,requestHistoryOptions} from '../../src/services/requestHistory.service.js';
import {decodeHistoryCursor,encodeHistoryCursor} from '../../src/services/requestHistoryCursor.js';
import {installFixtureHistoryOrderIndexes} from './history-benchmark-indexes.mjs';
const size=Number(process.env.HISTORY_SCALE_ROWS||1000000),db=new PGlite();let lastSql,lastValues;
const measured={query(sql,values){lastSql=sql;lastValues=values;return db.query(sql,values);}};
const p=(values,n)=>[...values].sort((a,b)=>a-b)[Math.ceil(values.length*n)-1];
try{
  await db.exec(`CREATE TABLE users(id int PRIMARY KEY,name text,email text);INSERT INTO users VALUES(7,'Fixture','fixture@test');
    CREATE TABLE expenses(id int PRIMARY KEY,site_id int NOT NULL,status text NOT NULL,approved_at timestamptz NOT NULL,
      created_at timestamptz NOT NULL,approved_by int,amount numeric);
    INSERT INTO expenses SELECT n,1,'approved','2025-01-01'::timestamptz+n*interval '1 microsecond','2024-01-01',7,10.25 FROM generate_series(1,${size}) n;`);
  await installFixtureHistoryOrderIndexes(db,['expenses']);
  const load=async after=>{
    const options=requestHistoryOptions({site_id:'1',pagination:'cursor',view:'summary',include_total:'false',after});
    options.authorizationScope='scale-fixture';const reader=createRequestHistoryReader(measured,options);
    reader.add("SELECT e.*,'expense' AS source FROM expenses e WHERE site_id=$1",[1]);return reader.read();
  };
  const first=await load();const cursor=decodeHistoryCursor(first.nextCursor),id=Math.floor(size/2);
  const {rows:[clock]}=await db.query('SELECT approved_at::text AS time FROM expenses WHERE id=$1',[id]);
  const deep=encodeHistoryCursor({...cursor,key:{time:clock.time,source:'expense',id:String(id)}});
  const report=[];
  for(const[name,after]of[['first_page',undefined],['mid_archive_cursor',deep]]){
    const times=[];for(let run=0;run<15;run++){const start=performance.now();const result=await load(after);times.push(performance.now()-start);if(result.rows.length!==20)throw new Error('Expected bounded page');}
    const {rows}=await db.query(`EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON) ${lastSql}`,lastValues),plan=rows[0]['QUERY PLAN'][0],nodes=[];
    const visit=node=>{nodes.push(node);(node.Plans||[]).forEach(visit);};visit(plan.Plan);
    report.push({case:name,p50_ms:+p(times,.5).toFixed(2),p95_ms:+p(times,.95).toFixed(2),sql_execution_ms:plan['Execution Time'],
      max_rows_removed:nodes.reduce((max,node)=>Math.max(max,node['Rows Removed by Filter']||0),0),
      index_scans:nodes.filter(node=>/Index.*Scan/.test(node['Node Type'])).length,page_size:20,total_count_requested:false});
  }
  const result={fixture_rows:size,engine:'PGlite; skinny disposable fixture; no hosted auth',results:report};
  await mkdir('benchmarks',{recursive:true});await writeFile('benchmarks/history-scale.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));
}finally{await db.close();}
