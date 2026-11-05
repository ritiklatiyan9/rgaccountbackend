import {pathToFileURL} from 'node:url';
import pool from '../config/db.js';
import {historyClock} from '../services/requestHistoryClock.js';

export const VERSION='236_history_keyset_order';
const tables=['transaction_transfer_approval_requests','plot_status_approvals','farmer_payments','land_deal_payments',
  'misc_income_entries','plot_commissions','plot_commission_payments','cash_flow_entries','firm_transactions','plot_payments',
  'plot_installment_payments','expenses','vendor_payments','plot_registry_payments','vendor_inventory_payments','day_book',
  'edit_requests','seek_permissions','loyalty_vault_transfers','wallet_imprest_transfers','imprest_expense_requests','imprest_returns','imprest_allocations'];
const included=['status','approved_at','resolved_at','decided_at','reviewed_at','confirmed_at','declined_at','updated_at','created_at',
  'created_by','requested_by','assigned_admin_id','sub_admin_id','sender_id','recipient_id'];
export function historyOrderIndexSql(table,columns,name,{concurrently=true,legacy=false}={}) {
  for(const identifier of [table,name])if(!/^[a-z_][a-z0-9_]*$/.test(identifier))throw new Error('Invalid history index identifier');
  const site=['site_id','farmer_id','plot_id'].find(field=>columns.has(field));
  if(!site)return null;
  const clock=historyClock(columns,'').event;
  const key=legacy?`${site},lower(status::text),id DESC`:`${site},(${clock}) DESC NULLS LAST,id DESC`;
  const include=included.filter(field=>columns.has(field));
  return `CREATE INDEX ${concurrently?'CONCURRENTLY ':''}${name} ON public.${table} (${key})
    ${include.length?`INCLUDE (${include.join(',')})`:''}
    WHERE lower(status::text) IN ('approved','accepted','received','returned','rejected','declined')
    ${table==='cash_flow_entries'&&columns.has('source_module')?'AND source_module IS NULL':''}`;
}

async function migrate(database,{concurrently=true,legacy=false,log=()=>{}}={}) {
  const db=await database.connect();const changed=[];
  try{
    await db.query('SELECT pg_advisory_lock(hashtext($1))',[VERSION]);
    await db.query("SET lock_timeout='3s'");await db.query("SET statement_timeout='90s'");
    const {rows}=await db.query(`SELECT table_name,column_name,data_type,udt_name,current_setting('TimeZone') AS history_timezone
      FROM information_schema.columns c WHERE table_schema='public' AND table_name=ANY($1::text[])
        AND EXISTS(SELECT 1 FROM pg_class r JOIN pg_namespace n ON n.oid=r.relnamespace
          WHERE r.relname=c.table_name AND n.nspname=c.table_schema AND r.relkind='r')`,[tables]);
    const schema=new Map();for(const row of rows){if(!schema.has(row.table_name))schema.set(row.table_name,new Map());schema.get(row.table_name).set(row.column_name,row);}
    const marker=legacy?'235_archive_scopes':VERSION;
    for(const[table,columns]of schema){
      if(!columns.has('status')||!columns.has('id'))continue;
      const name=`request_history_${table}`,temporary=`rh_next_${table}`,old=`rh_old_${table}`;
      const {rows:current}=await db.query(`SELECT i.indisvalid,obj_description(c.oid,'pg_class') AS marker FROM pg_class c
        JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_index i ON i.indexrelid=c.oid
        WHERE n.nspname='public' AND c.relname=$1`,[name]);
      if(current[0]?.indisvalid&&current[0].marker===marker){
        await db.query(`DROP INDEX ${concurrently?'CONCURRENTLY ':''}IF EXISTS public.${old}`);continue;
      }
      const sql=historyOrderIndexSql(table,columns,temporary,{concurrently,legacy});if(!sql)continue;
      await db.query(`DROP INDEX ${concurrently?'CONCURRENTLY ':''}IF EXISTS public.${temporary}`);
      await db.query(sql);
      // Replacement is built while the old index remains usable. Only the
      // catalog renames take a short transaction; record values never change.
      await db.query(`DROP INDEX ${concurrently?'CONCURRENTLY ':''}IF EXISTS public.${old}`);
      await db.query('BEGIN');
      try{
        if(current.length)await db.query(`ALTER INDEX public.${name} RENAME TO ${old}`);
        await db.query(`ALTER INDEX public.${temporary} RENAME TO ${name}`);
        await db.query(`COMMENT ON INDEX public.${name} IS '${marker}'`);
        await db.query('COMMIT');
      }catch(error){await db.query('ROLLBACK');throw error;}
      await db.query(`DROP INDEX ${concurrently?'CONCURRENTLY ':''}IF EXISTS public.${old}`);
      await db.query(`ANALYZE public.${table}`);changed.push(name);log(name);
    }
    if(legacy)await db.query('DELETE FROM app_schema_migrations WHERE version=$1',[VERSION]);
    else await db.query('INSERT INTO app_schema_migrations(version) VALUES($1) ON CONFLICT DO NOTHING',[VERSION]);
    return changed;
  }finally{
    try{await db.query('RESET lock_timeout');await db.query('RESET statement_timeout');await db.query('SELECT pg_advisory_unlock(hashtext($1))',[VERSION]);}
    finally{db.release();}
  }
}
export const up=(database=pool,options)=>migrate(database,options);
export const down=(database=pool,options)=>migrate(database,{...options,legacy:true});
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  (process.argv.includes('--down')?down:up)(pool,{log:name=>console.log(`Ready: ${name}`)})
    .then(changed=>console.log(`History ordering indexes ready (${changed.length} replaced)`))
    .catch(error=>{console.error(error.message);process.exitCode=1;}).finally(()=>pool.end());
}
