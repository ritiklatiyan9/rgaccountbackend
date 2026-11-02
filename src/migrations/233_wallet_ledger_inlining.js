import {pathToFileURL} from 'node:url';
import pool from '../config/db.js';

export const VERSION='233_wallet_ledger_inlining';
const viewSql=`SELECT pg_get_viewdef(c.oid,true) AS definition FROM pg_class c
  JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=current_schema() AND c.relname='ledger_entries' AND c.relkind='v'`;

// Mask quoted text/comments before locating CTE declarations. Never rewrite a
// description literal that happens to contain "base AS (...)".
function codeOnly(sql) {
 const chars=sql.split('');let index=0;
 const hide=(from,to)=>{for(let i=from;i<to;i++)if(chars[i]!=='\n')chars[i]=' ';};
 while(index<sql.length){
  const start=index;
  if(sql[index]==="'"){
   index++;
   while(index<sql.length){if(sql[index]==="'"){index++;if(sql[index]==="'"){index++;continue;}break;}if(sql[index]==='\\'){index+=2;}else index++;}
   hide(start,index);
  }else if(sql[index]==='"'){
   index++;while(index<sql.length){if(sql[index]==='"'){index++;if(sql[index]==='"'){index++;continue;}break;}index++;}hide(start,index);
  }else if(sql.startsWith('--',index)){
   index=sql.indexOf('\n',index);if(index<0)index=sql.length;hide(start,index);
  }else if(sql.startsWith('/*',index)){
   index+=2;let depth=1;while(index<sql.length&&depth){if(sql.startsWith('/*',index)){depth++;index+=2;}else if(sql.startsWith('*/',index)){depth--;index+=2;}else index++;}hide(start,index);
  }else{
   const tag=/^\$(?:[a-zA-Z_][a-zA-Z_0-9]*)?\$/.exec(sql.slice(index));
   if(tag){const end=sql.indexOf(tag[0],index+tag[0].length);index=end<0?sql.length:end+tag[0].length;hide(start,index);}else index++;
  }
 }
 return chars.join('');
}
export function inlineWalletLedgerDefinition(source) {
 if(typeof source!=='string'||!source.trim())throw Error('ledger_entries view definition is missing');
 const mask=codeOnly(source),edits=[];
 for(const name of ['raw_base','base','posted']){
  const matches=[...mask.matchAll(new RegExp(`\\b${name}\\s+AS\\s*(?:(?:NOT\\s+)?MATERIALIZED\\s*)?\\(`,'gi'))];
  if(matches.length!==1)throw Error(`Expected exactly one ${name} CTE; refusing to change ledger policy`);
  const found=matches[0];if(/\bNOT\s+MATERIALIZED\b/i.test(found[0]))continue;
  edits.push({start:found.index,end:found.index+found[0].length,text:`${name} AS NOT MATERIALIZED (`});
 }
 let definition=source;
 for(const edit of edits.sort((a,b)=>b.start-a.start))definition=definition.slice(0,edit.start)+edit.text+definition.slice(edit.end);
 return {definition,changed:edits.length>0};
}
async function readDefinition(db){return (await db.query(viewSql)).rows[0]?.definition;}
async function projectionFingerprint(db){
 return (await db.query(`SELECT count(*)::text AS count,COALESCE(sum(credit),0)::text AS credit,
  COALESCE(sum(debit),0)::text AS debit,
  md5(COALESCE(string_agg(md5(to_jsonb(l)::text),'' ORDER BY id::text,bucket,md5(to_jsonb(l)::text)),'')) AS hash
  FROM ledger_entries l`)).rows[0];
}
async function install(db,before,{verifyProjection=false}={}){
 const optimized=inlineWalletLedgerDefinition(before);
 if(!optimized.changed)return {changed:false};
 const beforeFingerprint=verifyProjection?await projectionFingerprint(db):null;
 await db.query(`CREATE TABLE IF NOT EXISTS app_schema_migration_artifacts(
  version text NOT NULL,object_name text NOT NULL,before_definition text NOT NULL,after_definition text NOT NULL,
  captured_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(version,object_name))`);
 await db.query('CREATE OR REPLACE VIEW ledger_entries AS '+optimized.definition.replace(/;\s*$/,''));
 const afterFingerprint=verifyProjection?await projectionFingerprint(db):null;
 if(verifyProjection&&JSON.stringify(beforeFingerprint)!==JSON.stringify(afterFingerprint))throw Error('Ledger projection verification failed; optimization rolled back');
 const after=await readDefinition(db);
 await db.query(`INSERT INTO app_schema_migration_artifacts(version,object_name,before_definition,after_definition)
  VALUES($1,'ledger_entries',$2,$3) ON CONFLICT(version,object_name) DO UPDATE SET
  before_definition=EXCLUDED.before_definition,after_definition=EXCLUDED.after_definition,captured_at=now()`,[VERSION,before,after]);
 return {changed:true,...(verifyProjection?{verification:{before:beforeFingerprint,after:afterFingerprint}}:{})};
}
// Reads only on current installations. Older repeatable migrations can restore
// materialization, so verify the definition after the startup migration chain.
export async function ensureWalletLedgerInlining(database=pool){
 const current=await readDefinition(database);if(!current)return {changed:false};
 if(!inlineWalletLedgerDefinition(current).changed)return {changed:false};
 const db=await database.connect();
 try{
  await db.query("BEGIN ISOLATION LEVEL REPEATABLE READ; SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s'");
  await db.query("SELECT pg_advisory_xact_lock(hashtext('233_wallet_ledger_inlining'))");
  const result=await install(db,await readDefinition(db));await db.query('COMMIT');return result;
 }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
}
export async function up(database=pool,{verifyProjection=false}={}){
 const db=await database.connect();
 try{
  await db.query("BEGIN ISOLATION LEVEL REPEATABLE READ; SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s'");
  await db.query("SELECT pg_advisory_xact_lock(hashtext('233_wallet_ledger_inlining'))");
  const before=await readDefinition(db);if(!before)throw Error('ledger_entries must be an existing view');
  const result=await install(db,before,{verifyProjection});
  await db.query('INSERT INTO app_schema_migrations(version) VALUES($1) ON CONFLICT DO NOTHING',[VERSION]);
  await db.query('COMMIT');return result;
 }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
}
export async function down(database=pool){
 const db=await database.connect();
 try{
  await db.query("BEGIN; SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s'");
  await db.query("SELECT pg_advisory_xact_lock(hashtext('233_wallet_ledger_inlining'))");
  const artifact=(await db.query("SELECT before_definition,after_definition FROM app_schema_migration_artifacts WHERE version=$1 AND object_name='ledger_entries'",[VERSION])).rows[0];
  if(!artifact)throw Error('No saved ledger definition exists for rollback');
  if(await readDefinition(db)!==artifact.after_definition)throw Error('Ledger policy changed after this optimization; review the saved definitions before rollback');
  await db.query('CREATE OR REPLACE VIEW ledger_entries AS '+artifact.before_definition.replace(/;\s*$/,''));
  await db.query('DELETE FROM app_schema_migrations WHERE version=$1',[VERSION]);await db.query('COMMIT');
 }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 (process.argv.includes('--down')?down():up(pool,{verifyProjection:process.argv.includes('--verify-projection')})).then(result=>console.log(JSON.stringify(result||{rolled_back:true})))
  .catch(error=>{console.error(error.message);process.exitCode=1;}).finally(()=>pool.end());
}
