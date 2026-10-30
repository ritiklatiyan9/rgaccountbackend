import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { buildOccurrences, parseDate, dateKey } from '../src/services/complianceEngine.service.js';
import { monthlyCalendarRule, calendarTemplateDefaults } from '../src/services/calendarRepeat.service.js';
import { up } from '../src/migrations/202_calendar_monthly_repeat.js';

const source = readFileSync(new URL('../src/controllers/compliance.controller.js', import.meta.url), 'utf8');
const between = (start,end) => source.slice(source.indexOf(start),source.indexOf(end));

test('monthly dates clamp short months, respect an end date and validate input', () => {
  for (const [start,until,expected] of [
    ['2040-01-31','2040-04-30',['2040-01-31','2040-02-29','2040-03-31','2040-04-30']],
    ['2041-01-30','2041-03-29',['2041-01-30','2041-02-28']],
    ['2040-12-12','2041-02-12',['2040-12-12','2041-01-12','2041-02-12']],
  ]) {
    const rule=monthlyCalendarRule(true,start,until);
    assert.deepEqual(buildOccurrences({frequency:'MONTHLY', ...rule, startDate:rule.startDate, dueDateRule:rule.dueDateRule}).map(row=>row.dueDate),expected);
  }
  assert.equal(monthlyCalendarRule(false,'bad','bad'),null);
  for (const args of [['true','2040-01-01'],[true,'bad'],[true,'2040-01-01','2039-12-31'],[true,'2040-01-01','2040-02-30']]) assert.throws(()=>monthlyCalendarRule(...args),error=>error.statusCode===400);
});

test('calendar creation and later scheduler runs preserve time and do not duplicate monthly obligations', async () => {
 const pg=new PGlite();
 const query=async(sql,params)=>{const r=params?.length?await pg.query(sql,params):(await pg.exec(sql)).at(-1); return {...r, rows:r?.rows||[],rowCount:r?.rows?.length||r?.affectedRows||0};};
 const db={query,connect:async()=>({query,release(){}})};
 try {
  await pg.exec(`CREATE TABLE sites(id int PRIMARY KEY,organization_id int); INSERT INTO sites VALUES(1,1),(2,2);
   CREATE TABLE compliance_templates(id serial PRIMARY KEY,organization_id int,name text,category text,subcategory text,compliance_type text,description text,applicable_site_ids jsonb,frequency text,start_date date,end_date date,due_date_rule jsonb,default_risk text,default_reminder_days int[],required_checklist jsonb,created_by int,updated_by int,authority_id int,applicable_state text,applicable_district text,default_reviewer_id int,default_approver_id int,approval_required boolean DEFAULT false,is_active boolean DEFAULT true,deleted_at timestamptz);
   CREATE TABLE compliance_items(id serial PRIMARY KEY,organization_id int,site_id int,template_id int,authority_id int,compliance_code text UNIQUE,title text,description text,category text,subcategory text,compliance_type text,state text,district text,frequency text,original_due_date date,current_due_date date,reminder_days int[],reviewing_manager_id int,approving_authority_id int,risk_level text,priority text,approval_required boolean DEFAULT false,generated_key text,created_by int,updated_by int,metadata jsonb DEFAULT '{}',status text DEFAULT 'NOT_STARTED',deleted_at timestamptz);
   CREATE UNIQUE INDEX generated_item ON compliance_items(organization_id,generated_key) WHERE generated_key IS NOT NULL AND deleted_at IS NULL;
   CREATE TABLE compliance_checklist_items(organization_id int,compliance_item_id int,title text,description text,is_mandatory boolean,assigned_to int,due_date date,required_document_type text,sequence int);
   CREATE TABLE compliance_status_history(organization_id int,compliance_item_id int,previous_status text,new_status text,changed_by int,comment text);`);
  await up(db); await up(db);
  let code=0; const queued=[];
  const context=vm.createContext({pool:db, monthlyCalendarRule,calendarTemplateDefaults,buildOccurrences,parseDate,
   asyncHandler:fn=>fn, settingsFor:async()=>({default_reminder_days:[1,0]}),
   assertComplianceSiteAccess:async(req,res,id)=>id===1?1:false,isOrgAdmin:()=>true,
   cleanCompliancePayload:body=>Object.fromEntries(Object.entries(body).filter(([key])=>['title','description','category','compliance_type','priority','risk_level','current_due_date','metadata'].includes(key))),
   text:value=>value?String(value).trim():null,storedDate:value=>parseDate(value)?dateKey(parseDate(value)):null,
   parsePositiveId:value=>Number(value)||null,accessibleUser:async()=>null,assertOwnedReference:async()=>null,
   codeFor:()=>`CMP-${++code}`,jsonArray:value=>Array.isArray(value)?value:[],
   writeComplianceAudit:async()=>{}, queueCalendarSync:(org,type,id)=>queued.push(id),console});
  vm.runInContext(between('export const createComplianceItem','export const updateComplianceItem').replace('export const ','const ')+
    between('export async function generateTemplateItems','export const applyTemplate').replace('export async ','async ')+
    ';globalThis.create=createComplianceItem;globalThis.generate=generateTemplateItems;',context);
  const req={user:{organization_id:1,id:10},body:{site_id:1,title:'Monthly review',priority:'LOW',risk_level:'HIGH',current_due_date:'2040-01-31',metadata:{event_time:'09:30'},repeat_monthly:true,repeat_until:'2040-04-30'}};
  const res={status(n){this.statusCode=n;return this;},json(value){this.body=value;return this;}};
  await context.create(req,res);
  assert.equal(res.statusCode,201); assert.equal(res.body.repeating.generated,4); assert.equal(queued.length,4);
  let rows=(await query('SELECT * FROM compliance_items ORDER BY current_due_date')).rows;
  assert.deepEqual(rows.map(row=>dateKey(row.current_due_date)),['2040-01-31','2040-02-29','2040-03-31','2040-04-30']);
  for(const row of rows){assert.equal(row.title,'Monthly review');assert.equal(row.metadata.event_time,'09:30');assert.equal(row.priority,'LOW');assert.equal(row.risk_level,'HIGH');assert.equal(row.template_id,res.body.repeating.template_id);}
  await query("UPDATE compliance_items SET deleted_at=NOW() WHERE current_due_date='2040-02-29'");
  const result=await context.generate({req,templateId:res.body.repeating.template_id,siteIds:[1],startDate:'2040-01-01',throughDate:'2040-12-31',db});
  assert.equal(result.generated,0); assert.equal((await query('SELECT COUNT(*)::int AS count FROM compliance_items')).rows[0].count,4);
  assert.equal((await query('SELECT COUNT(*)::int AS count FROM compliance_items WHERE deleted_at IS NULL')).rows[0].count,3,'applying a template never recreates a deleted occurrence');
  const schedulerSource=readFileSync(new URL('../src/services/complianceScheduler.service.js',import.meta.url),'utf8');
  vm.runInContext(schedulerSource.slice(schedulerSource.indexOf('export async function generateRecurringItems'),schedulerSource.indexOf('async function refreshOverdueAndRisk')).replace('export async ','async ')+ ';globalThis.scheduler=generateRecurringItems;',context);
  const pending=[]; await context.scheduler(db,pending); assert.equal(pending.length,0);
  await query('UPDATE compliance_templates SET start_date=$1,end_date=$2 WHERE id=$3',['2026-10-01','2026-12-31',res.body.repeating.template_id]);
  await context.scheduler(db,pending); assert.equal(pending.length,3);
  rows=(await query("SELECT * FROM compliance_items WHERE current_due_date < '2030-01-01' ORDER BY current_due_date")).rows;
  assert.deepEqual(rows.map(row=>dateKey(row.current_due_date)),['2026-10-31','2026-11-30','2026-12-31']);
  assert.ok(rows.every(row=>row.metadata.event_time==='09:30' && row.title==='Monthly review'));
  await query("UPDATE compliance_items SET deleted_at=NOW() WHERE current_due_date='2026-11-30'");
  await context.scheduler(db,[]); assert.equal((await query('SELECT COUNT(*)::int AS count FROM compliance_items')).rows[0].count,7);
  assert.equal((await query("SELECT COUNT(*)::int AS count FROM compliance_items WHERE current_due_date='2026-11-30' AND deleted_at IS NULL")).rows[0].count,0,'scheduler keeps a deleted monthly date removed');
  await assert.rejects(()=>context.generate({req:{user:{organization_id:2}},templateId:res.body.repeating.template_id,siteIds:[2],startDate:'2040-01-01',throughDate:'2040-12-31',db}),error=>error.statusCode===404);
 } finally {await pg.close();}
});
