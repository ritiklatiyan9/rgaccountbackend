// Repairs only the two proven approval metadata changes caused by the initial
// migration-245 backfill. Dry-run is the default. No booking/business data is changed.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import pool from '../src/config/db.js';

const ignored = ['id','created_at','created_by','updated_at','approval_status','approval_requested_by','approval_requested_at',
  'approved_by','approved_at','approval_original_data','approval_proposed_data'];
const metadata = ['approval_status','approval_requested_by','approval_requested_at','approved_by','approved_at','updated_at',
  'approval_original_data','approval_proposed_data'];
const omit = (row, fields) => Object.fromEntries(Object.entries(row).filter(([key]) => !fields.includes(key)));
const business = row => omit(row, ignored);
const sameTime = (a,b) => a != null && b != null && new Date(a).getTime() === new Date(b).getTime();
const pick = (row, keys) => Object.fromEntries(keys.map(key => [key,row[key]]));

export function buildRecoveryPlan({ currentRows, allSiteBackup, registeredBackup, migrationTime, sibling }) {
  assert.equal(currentRows.length,2,'Recovery requires exactly two affected plots');
  assert.deepEqual(currentRows.map(row=>row.id).sort((a,b)=>a-b),[5,431]);
  assert.equal(sibling.approval_status,'rejected');
  assert.equal(sibling.approved_by,7);
  assert.equal(sibling.approved_at,'2026-10-15 08:30:35.602967+00');
  assert.equal(sibling.requested_at,'2026-10-13 10:54:13.245745+00');
  const legacy431=registeredBackup.before.find(row=>row.plot_id===431)?.plot_before;
  assert.ok(legacy431,'Missing registered-area backup for plot431');
  return currentRows.map(current=>{
    const saved=allSiteBackup.plots.find(row=>row.id===current.id);
    assert.ok(saved,`Missing backup for plot${current.id}`);
    assert.equal(current.site_id,current.id===5?2:5);
    assert.equal(current.approval_status,'pending');
    assert.ok(sameTime(current.approval_requested_at,migrationTime),'Plot changed after the migration');
    assert.ok(sameTime(current.updated_at,migrationTime),'Plot changed after the migration');
    assert.equal(current.approved_by,null);
    assert.equal(current.approved_at,null);
    assert.ok(Array.isArray(current.co_applicants)&&current.co_applicants.length===1);
    assert.deepEqual(current.approval_original_data.co_applicants,[]);
    assert.deepEqual(current.approval_proposed_data.co_applicants,current.co_applicants);
    assert.deepEqual(omit(current.approval_original_data,['co_applicants']),omit(current.approval_proposed_data,['co_applicants']),'Another pending change exists');
    const savedBusiness=business(saved);
    const keys=Object.keys(savedBusiness);
    assert.equal(keys.length,49,'Historical snapshot schema changed');
    assert.deepEqual(omit(pick(current,keys),['plot_size_mtr']),omit(savedBusiness,['plot_size_mtr']),'Booking business data changed since backup');
    let values;
    if(current.id===5){
      assert.equal(saved.created_by,2);
      assert.equal(current.approval_requested_by,2);
      assert.equal(Number(saved.plot_size_mtr),1000);
      assert.equal(Number(current.plot_size_mtr),1000.326);
      assert.deepEqual(Object.keys(sibling.approval_original_data).sort(),keys.sort());
      assert.deepEqual(Object.keys(sibling.approval_proposed_data).sort(),keys.sort());
      values={approval_status:'rejected',approval_requested_by:2,approval_requested_at:sibling.requested_at,
        approved_by:7,approved_at:sibling.approved_at,updated_at:sibling.approved_at,
        approval_original_data:savedBusiness,approval_proposed_data:{...savedBusiness,plot_size_mtr:current.plot_size_mtr}};
    }else{
      assert.equal(saved.approval_status,'approved');
      assert.equal(saved.approved_by,7);
      assert.deepEqual(pick(current,keys),savedBusiness,'Plot431 business data changed since backup');
      assert.deepEqual(omit(business(legacy431),['plot_size_mtr']),omit(savedBusiness,['plot_size_mtr']));
      assert.equal(Object.keys(business(legacy431)).length,49);
      values={...pick(saved,metadata.filter(key=>!key.startsWith('approval_original')&&!key.startsWith('approval_proposed'))),
        updated_at:sibling.requested_at, // The manual snapshot restoration ran in the all-site correction transaction.
        approval_original_data:business(legacy431),approval_proposed_data:savedBusiness};
    }
    return {id:current.id,site_id:current.site_id,values};
  });
}

export async function runRecovery({ apply=false, database=pool }={}) {
  const [allSiteBackup,registeredBackup]=await Promise.all([
    readFile(new URL('../../reports/all-site-area-correction-before-1791888859826.json',import.meta.url),'utf8').then(JSON.parse),
    readFile(new URL('../../reports/registered-area-correction-before-1791888358455.json',import.meta.url),'utf8').then(JSON.parse),
  ]);
  const client=await database.connect();
  try{
    await client.query(apply?'BEGIN':'BEGIN READ ONLY');
    await client.query("SET LOCAL lock_timeout='5s'");
    await client.query("SET LOCAL statement_timeout='30s'");
    if(apply) await client.query('LOCK TABLE plots IN SHARE ROW EXCLUSIVE MODE');
    const {rows:[migration]}=await client.query("SELECT applied_at::text AS applied_at FROM app_schema_migrations WHERE version='245_plot_co_applicants'");
    assert.ok(migration,'Migration245 is not installed');
    const {rows}=await client.query(`SELECT to_jsonb(p) AS record FROM plots p WHERE id=ANY($1::int[]) ORDER BY id${apply?' FOR UPDATE':''}`,[[5,431]]);
    const currentRows=rows.map(row=>row.record);
    const {rows:[sibling]}=await client.query(`SELECT approval_status,approved_by,approved_at::text AS approved_at,
      approval_requested_at::text AS requested_at,approval_original_data,approval_proposed_data FROM plots WHERE id=6`);
    const plan=buildRecoveryPlan({currentRows,allSiteBackup,registeredBackup,migrationTime:migration.applied_at,sibling});
    // Audit proof: the latest recorded decision for plot5 is the batch rejection,
    // and there is no later single/bulk decision for either plot.
    const {rows:decisions}=await client.query(`SELECT id,status_code,user_id,created_at FROM audit_logs WHERE
      (request_path ~ '^/approvals/(5|431)/(approve|reject)([?]|$)' AND request_path LIKE '%source=plot_status%')
      OR (request_path IN('/approvals/bulk-approve','/approvals/bulk-reject') AND EXISTS(
        SELECT 1 FROM jsonb_array_elements(COALESCE(new_values->'request'->'items','[]'::jsonb)) item
        WHERE item->>'source'='plot_status' AND item->>'id' IN('5','431'))) ORDER BY created_at DESC LIMIT 1`);
    assert.equal(String(decisions[0]?.id),'46893','A newer approval decision exists; audit again');
    assert.equal(decisions[0].status_code,200);
    assert.equal(decisions[0].user_id,7);
    if(apply){
      const backup=new URL(`../../reports/coapp-migration-approval-recovery-before-${Date.now()}.json`,import.meta.url);
      await writeFile(backup,JSON.stringify({savedAt:new Date().toISOString(),migrationTime:migration.applied_at,currentRows,plan},null,2),{flag:'wx',mode:0o600});
      const triggerNames=['plots_queue_status_approval','trg_approval_change_snapshot','trg_plots_updated_at'];
      const {rows:triggers}=await client.query("SELECT tgname,tgenabled FROM pg_trigger WHERE tgrelid='plots'::regclass AND tgname=ANY($1::text[]) ORDER BY tgname",[triggerNames]);
      assert.equal(triggers.length,3,'Approval trigger inventory changed');
      assert.ok(triggers.every(trigger=>trigger.tgenabled==='O'),'Approval trigger state changed');
      for(const name of triggerNames) await client.query(`ALTER TABLE plots DISABLE TRIGGER ${name}`);
      for(const row of plan){
        const keys=Object.keys(row.values);
        const values=keys.map(key=>key.endsWith('_data')?JSON.stringify(row.values[key]):row.values[key]);
        const updated=await client.query(`UPDATE plots SET ${keys.map((key,index)=>`${key}=$${index+2}${key.endsWith('_data')?'::jsonb':''}`).join(',')} WHERE id=$1 AND site_id=$${keys.length+2} RETURNING id`,[row.id,...values,row.site_id]);
        assert.equal(updated.rowCount,1);
      }
      // Existing commission constraints are deferred; validate before re-enabling
      // triggers, so ALTER TABLE never sees pending trigger events.
      await client.query('SET CONSTRAINTS ALL IMMEDIATE');
      for(const name of triggerNames) await client.query(`ALTER TABLE plots ENABLE TRIGGER ${name}`);
      const {rows:after}=await client.query('SELECT to_jsonb(p) AS record FROM plots p WHERE id=ANY($1::int[]) ORDER BY id',[[5,431]]);
      for(let i=0;i<after.length;i++){
        assert.deepEqual(omit(after[i].record,metadata),omit(currentRows[i],metadata),'Recovery changed booking data');
        const expected=plan.find(row=>row.id===after[i].record.id).values;
        for(const key of metadata){
          if(key.endsWith('_at')) assert.ok(sameTime(after[i].record[key],expected[key]) || after[i].record[key]===expected[key]);
          else assert.deepEqual(after[i].record[key],expected[key],`Recovery mismatch ${key}`);
        }
      }
      await client.query('COMMIT');
      return {applied:true,plots:plan.map(row=>({id:row.id,approval_status:row.values.approval_status})),backup:backup.pathname};
    }
    await client.query('ROLLBACK');
    return {applied:false,verified:true,plots:plan.map(row=>({id:row.id,approval_status:row.values.approval_status,snapshot_keys:Object.keys(row.values.approval_original_data).length}))};
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  runRecovery({apply:process.argv.includes('--apply')}).then(result=>console.log(JSON.stringify(result)))
    .catch(error=>{console.error(error.message);process.exitCode=1;}).finally(()=>pool.end());
}
