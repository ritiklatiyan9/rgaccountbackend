import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRecoveryPlan } from '../scripts/recover-plot-coapp-migration-approvals.mjs';

const metadata=['id','created_at','created_by','updated_at','approval_status','approval_requested_by','approval_requested_at','approved_by','approved_at','approval_original_data','approval_proposed_data'];
const business=row=>Object.fromEntries(Object.entries(row).filter(([key])=>!metadata.includes(key)));
function fixture(){
  const migrationTime='2026-11-15T05:21:27.044Z';
  const fields=Object.fromEntries(Array.from({length:46},(_,index)=>[`field_${index}`,index]));
  const row=(id,site_id,area)=>({id,site_id,status:id===5?'BOOKED':'REGISTRY',plot_size_mtr:area,...fields,
    created_by:id===5?2:5,created_at:'2026-01-01T00:00:00Z',updated_at:'2026-10-13T10:47:19.446166Z',
    approval_status:'approved',approval_requested_by:id===5?null:5,approval_requested_at:id===5?null:'2026-10-13T10:45:53.121585Z',
    approved_by:id===5?null:7,approved_at:id===5?null:'2026-10-13T10:47:19.446166Z'});
  const saved5=row(5,2,1000),saved431=row(431,5,196.554),legacy431=row(431,5,196.55);
  const currentRows=[saved5,saved431].map(saved=>{
    const current={...saved,plot_size_mtr:saved.id===5?1000.326:saved.plot_size_mtr,
      approval_status:'pending',approval_requested_by:saved.id===5?2:5,approval_requested_at:migrationTime,
      approved_by:null,approved_at:null,updated_at:migrationTime,co_applicants:[{full_name:'Test applicant'}]};
    current.approval_original_data={...business(current),co_applicants:[]};
    current.approval_proposed_data=business(current);
    return current;
  });
  return {currentRows,allSiteBackup:{plots:[saved5,saved431]},registeredBackup:{before:[{plot_id:431,plot_before:legacy431}]},migrationTime,
    sibling:{approval_status:'rejected',approved_by:7,approved_at:'2026-10-15 08:30:35.602967+00',requested_at:'2026-10-13 10:54:13.245745+00',
      approval_original_data:business(saved5),approval_proposed_data:{...business(saved5),plot_size_mtr:1000.326}}};
}

test('recovery reconstructs each historical decision and 49-key snapshots without altering booking data',()=>{
  const input=fixture(),before=structuredClone(input);
  const [five,registry]=buildRecoveryPlan(input);
  assert.equal(five.values.approval_status,'rejected');
  assert.equal(five.values.approved_by,7);
  assert.equal(five.values.approval_requested_by,2);
  assert.equal(five.values.approved_at,'2026-10-15 08:30:35.602967+00');
  assert.equal(five.values.approval_original_data.plot_size_mtr,1000);
  assert.equal(five.values.approval_proposed_data.plot_size_mtr,1000.326);
  assert.equal(registry.values.approval_status,'approved');
  assert.equal(registry.values.approved_at,'2026-10-13T10:47:19.446166Z');
  assert.equal(registry.values.updated_at,'2026-10-13 10:54:13.245745+00');
  assert.equal(registry.values.approval_original_data.plot_size_mtr,196.55);
  assert.equal(registry.values.approval_proposed_data.plot_size_mtr,196.554);
  for(const record of [five,registry])assert.equal(Object.keys(record.values.approval_original_data).length,49);
  assert.deepEqual(input,before);
});

test('recovery rejects later edits, other pending changes, mismatched sites or changed historical evidence',()=>{
  for(const mutate of [
    input=>{input.currentRows[0].updated_at='2026-11-16T00:00:00Z';},
    input=>{input.currentRows[0].approval_proposed_data.status='CHANGED';},
    input=>{input.currentRows[0].site_id=9;},
    input=>{input.currentRows[0].field_0=999;},
    input=>{input.sibling.approved_by=99;},
    input=>{input.registeredBackup.before=[];},
  ]){
    const input=fixture();mutate(input);assert.throws(()=>buildRecoveryPlan(input));
  }
});
