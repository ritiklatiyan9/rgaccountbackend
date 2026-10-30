import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const source=readFileSync(new URL('../src/controllers/compliance.controller.js',import.meta.url),'utf8');
const between=(start,end)=>source.slice(source.indexOf(start),source.indexOf(end)).replace('export const ','const ');
test('calendar deletion uses scoped soft deletes, an audit reason and reminder/calendar reconciliation',async()=>{
  const writes=[],audits=[],syncs=[];let existing={id:12,site_id:2,title:'Review'};
  const context=vm.createContext({asyncHandler:fn=>fn,parsePositiveId:value=>Number(value),
    getScopedComplianceEntity:async()=>existing,requireReason:value=>{if(!String(value||'').trim())throw Object.assign(new Error('A reason is required'),{statusCode:400});return value.trim();},
    pool:{query:async(sql,params)=>{writes.push({sql,params});return{rows:[]};}},writeComplianceAudit:async(_db,_req,audit)=>audits.push(audit),queueCalendarSync:(...args)=>syncs.push(args),
    ENTITY_CONFIG:{case:{table:'legal_cases',label:'LEGAL_CASE'}},CALENDAR_EVENT_TYPES:{case:'LEGAL_HEARING'}});
  vm.runInContext(between('export const deleteComplianceItem','export const linkComplianceExpense')+between('export const deleteComplianceEntity','export const updateLegalNoticeStatus')+';globalThis.remove=deleteComplianceItem;globalThis.removeCase=deleteComplianceEntity("case");',context);
  const req={params:{id:'12'},user:{id:7,organization_id:1},body:{reason:'Duplicate',site_id:2}};
  const response=()=>({status(code){this.code=code;return this;},json(body){this.body=body;return this;}});
  for(const fn of [context.remove,context.removeCase]){
    const res=response();await fn(req,res);assert.equal(res.body.success,true);
    assert.match(writes.at(-1).sql,/SET deleted_at=NOW\(\)/);assert.doesNotMatch(writes.at(-1).sql,/DELETE FROM/);
    assert.equal(audits.at(-1).reason,'Duplicate');assert.equal(audits.at(-1).previousValue.title,'Review');assert.equal(syncs.at(-1)[2],12);
  }
  const count=writes.length;
  for(const fn of [context.remove,context.removeCase]){
    const moved=response();await fn({...req,body:{reason:'Duplicate',site_id:3}},moved);assert.equal(moved.code,409);
    await assert.rejects(fn({...req,body:{reason:'',site_id:2}},response()),error=>error.statusCode===400);
    existing=null;const missing=response();await fn(req,missing);assert.equal(missing.code,404);existing={id:12,site_id:2};
  }
  assert.equal(writes.length,count,'hidden, missing, moved and unconfirmed events never get deleted');
});
