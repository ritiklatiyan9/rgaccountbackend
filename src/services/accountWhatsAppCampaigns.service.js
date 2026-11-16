import { createHash, randomUUID } from 'node:crypto';
import pool from '../config/db.js';
import { accountWhatsAppError as fail, accountWhatsAppPhone } from './accountWhatsApp.spec.js';
import { accountWhatsAppRemoteTransport, uploadAccountWhatsAppDocument, uploadAccountWhatsAppTemplateDocument, sendAccountWhatsAppTemplate } from './accountWhatsApp.service.js';

export const CAMPAIGN_DOCUMENT_FILENAME = 'INVITATION.pdf';
export const CAMPAIGN_DOCUMENT_MAX_BYTES = 20 * 1024 * 1024;
const EDITABLE = new Set(['DRAFT','PENDING','APPROVED','REJECTED','SUBMISSION_FAILED']);
const ACTIVE = new Set(['QUEUED','SENDING','PAUSED','COMPLETED']);
const clean = value => String(value ?? '').trim();
const sha = value => createHash('sha256').update(value).digest('hex');
const nowIso = () => new Date().toISOString();
const positive = (value, name = 'Campaign') => { const n=Number(value); if(!Number.isSafeInteger(n)||n<=0)throw fail(`${name} is unavailable`,404);return n; };
const bounded = (value, fallback=30, max=100) => Number.isSafeInteger(Number(value)) ? Math.max(1,Math.min(max,Number(value))) : fallback;
const schemaKnown = new WeakSet();
const optionalTables = new WeakMap();
const audiences = new WeakMap();
function context(options={}) {
 const senderId=options.sender_id ?? process.env.WHATSAPP_PHONE_NUMBER_ID ?? '';
 return {db:options.db||pool,transport:options.transport||accountWhatsAppRemoteTransport,send:options.send||sendAccountWhatsAppTemplate,upload:options.upload||uploadAccountWhatsAppDocument,uploadTemplate:options.uploadTemplate||options.transport?.uploadTemplateMedia||uploadAccountWhatsAppTemplateDocument,recordOutbound:options.recordOutbound, senderId,configured:options.configured??Boolean(senderId),enabled:options.enabled??process.env.WHATSAPP_ENABLED==='true'};
}
function actor(user) {
 if(!['admin','super_admin'].includes(user?.role))throw fail('Only administrators manage WhatsApp campaigns',403);
 const org=Number(user.organization_id);if(!Number.isSafeInteger(org)||org<=0)throw fail('Organization context is required',403);return org;
}
export async function accountWhatsAppCampaignsReady(db=pool) {
 if(schemaKnown.has(db))return true;
 const {rows:[row]}=await db.query("SELECT to_regclass('public.account_whatsapp_campaigns') IS NOT NULL AND to_regclass('public.account_whatsapp_campaign_documents') IS NOT NULL AND to_regclass('public.account_whatsapp_campaign_recipients') IS NOT NULL AS ready");
 if(row?.ready)schemaKnown.add(db);return Boolean(row?.ready);
}
async function requireSchema(db){if(!await accountWhatsAppCampaignsReady(db))throw fail('WhatsApp campaigns need migration 251_account_whatsapp_campaigns. No recipients have been queued.',503);}
async function tx(db,fn){const c=await db.connect();try{await c.query('BEGIN');const out=await fn(c);await c.query('COMMIT');return out;}catch(error){await c.query('ROLLBACK').catch(()=>{});throw error;}finally{c.release();}}
async function optionalTable(db,name) {
 let cache=optionalTables.get(db);if(!cache){cache=new Map();optionalTables.set(db,cache);}
 const item=cache.get(name);if(item&&(item.exists||Date.now()-item.at<5000))return item.exists;
 const {rows:[row]}=await db.query('SELECT to_regclass($1) IS NOT NULL AS ready',[`public.${name}`]);
 const exists=Boolean(row?.ready);cache.set(name,{exists,at:Date.now()});return exists;
}
const META_SELECT=`SELECT c.*,d.filename AS document_filename,d.mime_type AS document_mime_type,d.size AS document_size,d.sha256 AS document_sha256 FROM account_whatsapp_campaigns c LEFT JOIN account_whatsapp_campaign_documents d ON d.campaign_id=c.id`;
async function load(db,org,id,lock=false){const {rows:[row]}=await db.query(`${META_SELECT} WHERE c.id=$1 AND c.organization_id=$2${lock?' FOR UPDATE OF c':''}`,[positive(id),org]);if(!row)throw fail('Campaign not found or unavailable to your account',404);return row;}
function siteIds(value) {
 if(value===undefined)return undefined;
 if(!Array.isArray(value)||value.length>1000)throw fail('Choose valid campaign sites');
 const ids=[...new Set(value.map(v=>positive(v,'Site')))].sort((a,b)=>a-b);return ids;
}
async function checkSites(db,org,ids){if(!ids?.length)return;const {rows}=await db.query('SELECT id FROM sites WHERE organization_id=$1 AND id=ANY($2::int[])',[org,ids]);if(rows.length!==ids.length)throw fail('One or more sites are unavailable to your organization',403);}
export function compileAccountWhatsAppCampaign(body,footer='') {
 const source=clean(body).replace(/\r\n?/g,'\n');const footerText=clean(footer);
 if(!source||source.length>1024)throw fail('Write an invitation of 1 to 1024 characters');
 if(footerText.length>60||/[{}\n]/.test(footerText))throw fail('Use a footer of up to 60 characters without variables or new lines');
 const rest=source.replace(/\{customer_name\}/g,'');if(/[{}]/.test(rest))throw fail('Only the {customer_name} variable is supported in invitations');
 const fields=[];const text=source.replace(/\{customer_name\}/g,()=>{fields.push('customer_name');return `{{${fields.length}}}`;});
 if(/^\{\{/.test(text)||/\}\}[^\p{L}\p{N}]*$/u.test(text))throw fail('Keep greeting or other text before and after a name variable');
 return {body:source,text,fields,footer:footerText};
}
function draft(input,current={}) {
 const title=clean(input.title??current.title??'Invitation');if(!title||title.length>120)throw fail('Give the campaign a title of up to 120 characters');
 const language=clean(input.language??current.language??'hi');if(!['hi','en'].includes(language))throw fail('Choose Hindi or English');
 const scope=input.scope??current.scope??'ALL_SITES';if(scope!=='ALL_SITES')throw fail('Choose the all-sites campaign audience');
 const body=clean(input.body??current.body??'').replace(/\r\n?/g,'\n');const footer=clean(input.footer??current.footer??'');
 if(body)compileAccountWhatsAppCampaign(body,footer);else if(footer.length>60||/[{}\n]/.test(footer))throw fail('Use a footer of up to 60 characters without variables or new lines');
 return {title,body,footer,language,scope,site_ids:siteIds(input.site_ids)??current.site_ids??[]};
}
function invalidateAudience(db){audiences.delete(db);}
async function audience(db,org,selected,senderId,{fresh=false}={}) {
 let cache=audiences.get(db);if(!cache){cache=new Map();audiences.set(db,cache);}
 const key=JSON.stringify([org,selected||[],senderId]);const hit=cache.get(key);
 if(!fresh&&hit&&Date.now()-hit.at<5000)return hit.value;
 const {rows}=await db.query(`SELECT m.id,m.site_id,m.full_name,m.phone,m.alt_phone,m.whatsapp,m.status FROM members m JOIN sites s ON s.id=m.site_id WHERE s.organization_id=$1 AND (cardinality($2::int[])=0 OR m.site_id=ANY($2::int[])) ORDER BY m.id LIMIT 100001`,[org,selected||[]]);
 if(rows.length>100000)throw fail('This audience exceeds 100,000 registrations. Select fewer sites.',422);
 const groups=new Map();let invalid=0,blocked=0,valid=0;
 for(const member of rows){
  if(clean(member.status).toUpperCase()==='BLOCKED'){blocked++;continue;}
  const phone=accountWhatsAppPhone(member.whatsapp)||accountWhatsAppPhone(member.phone)||accountWhatsAppPhone(member.alt_phone);
  if(!phone){invalid++;continue;}valid++;
  let item=groups.get(phone);if(!item){item={phone,full_name:clean(member.full_name)||'Guest',member_ids:[],site_ids:[],names:[]};groups.set(phone,item);}
  item.member_ids.push(Number(member.id));if(!item.site_ids.includes(Number(member.site_id)))item.site_ids.push(Number(member.site_id));
  const name=clean(member.full_name);if(name&&!item.names.includes(name))item.names.push(name);
 }
 let opted=new Set();
 if(await optionalTable(db,'account_whatsapp_opt_outs')){
  const {rows:optouts}=await db.query('SELECT phone FROM account_whatsapp_opt_outs WHERE organization_id=$1 AND sender_id=$2 AND active=true',[org,senderId]);opted=new Set(optouts.map(r=>accountWhatsAppPhone(r.phone)).filter(Boolean));
 }
 if(await optionalTable(db,'whatsapp_opt_outs')){
  const {rows:legacy}=await db.query('SELECT phone FROM whatsapp_opt_outs');for(const row of legacy){const value=accountWhatsAppPhone(row.phone);if(value)opted.add(value);}
 }
 let optedCount=0;const items=[];
 for(const item of groups.values()){
  if(opted.has(item.phone)){optedCount++;continue;}
  item.site_ids.sort((a,b)=>a-b);item.member_ids.sort((a,b)=>a-b);item.names.sort((a,b)=>a.localeCompare(b));
  item.full_name=item.names.find(n=>!/^Customer\s+\d+$/i.test(n))||item.full_name;
  items.push(item);
 }
 items.sort((a,b)=>a.phone.localeCompare(b.phone));
 const fingerprint=sha(JSON.stringify(items));
 const value={items,count:items.length,source_count:rows.length,invalid_count:invalid,blocked_count:blocked,opted_out_count:optedCount,duplicate_count:valid-groups.size,excluded_count:invalid+blocked+optedCount,fingerprint};
 cache.set(key,{at:Date.now(),value});if(cache.size>100)cache.delete(cache.keys().next().value);return value;
}
function revision(row,a){return `${row.revision}:${sha(`${row.document_sha256||''}:${a?.fingerprint||'frozen'}:${row.sender_id||''}`).slice(0,24)}`;}
function assertRevision(input,row,a){if(typeof input.revision!=='string'||input.revision!==revision(row,a))throw fail('The campaign or audience changed. Refresh and review it before continuing.',409);}
async function counts(db,ids){if(!ids.length)return new Map();const {rows}=await db.query(`SELECT campaign_id,COUNT(*)::int AS total,COUNT(*) FILTER(WHERE status='QUEUED')::int AS queued,COUNT(*) FILTER(WHERE status='SENDING')::int AS sending,COUNT(*) FILTER(WHERE status IN ('SENT','DELIVERED','READ'))::int AS sent,COUNT(*) FILTER(WHERE status IN ('DELIVERED','READ'))::int AS delivered,COUNT(*) FILTER(WHERE status='READ')::int AS read,COUNT(*) FILTER(WHERE status IN ('FAILED','UNKNOWN'))::int AS failed,COUNT(*) FILTER(WHERE status='UNKNOWN')::int AS unknown,COUNT(*) FILTER(WHERE status='SKIPPED')::int AS skipped,COUNT(*) FILTER(WHERE replied_at IS NOT NULL)::int AS replied FROM account_whatsapp_campaign_recipients WHERE campaign_id=ANY($1::bigint[]) GROUP BY campaign_id`,[ids]);return new Map(rows.map(r=>[String(r.campaign_id),r]));}
const emptyStats=()=>({total:0,queued:0,sending:0,sent:0,delivered:0,read:0,failed:0,unknown:0,skipped:0,replied:0});
function view(row,a,stats,ctx){
 const blockers=[];if(!row.body)blockers.push('Write the invitation message');if(!row.document_sha256)blockers.push('Attach INVITATION.pdf');
 if(row.template_status!=='APPROVED')blockers.push('Wait for Meta template approval');if(row.template_category!=='MARKETING')blockers.push('The template must have the Marketing category');
 if(!ctx.configured)blockers.push('Configure the WhatsApp sender');if(!ctx.enabled)blockers.push('Enable the WhatsApp sender');
 if(a&&a.count===0)blockers.push('The audience has no eligible WhatsApp numbers');
 if(row.sender_id&&row.sender_id!==ctx.senderId)blockers.push('Select the sender used for this template');
 return {id:row.id,organization_id:row.organization_id,title:row.title,body:row.body,footer:row.footer,language:row.language,scope:row.scope,site_ids:row.site_ids,status:row.status,revision:revision(row,a),template_status:row.template_status,template_name:row.template_name,template_category:row.template_category,template_error:row.template_error,meta_template_id:row.meta_template_id,document:row.document_sha256?{filename:CAMPAIGN_DOCUMENT_FILENAME,size:row.document_size,mime_type:'application/pdf',sha256:row.document_sha256}:null,audience_count:row.frozen_payload?.recipient_count??a?.count??null,audience:a?{count:a.count,source_count:a.source_count,invalid_count:a.invalid_count,blocked_count:a.blocked_count,opted_out_count:a.opted_out_count,duplicate_count:a.duplicate_count,excluded_count:a.excluded_count}:null,stats:stats||emptyStats(),readiness:{ready:blockers.length===0,blockers,manual_send_only:true},ready:blockers.length===0,blockers,can_edit:EDITABLE.has(row.status),created_at:row.created_at,updated_at:row.updated_at,queued_at:row.queued_at,completed_at:row.completed_at};
}
async function detail(ctx,org,id){const row=await load(ctx.db,org,id);const a=ACTIVE.has(row.status)?null:await audience(ctx.db,org,row.site_ids,row.sender_id||ctx.senderId);const stats=(await counts(ctx.db,[row.id])).get(String(row.id));return view(row,a,stats,ctx);}
export async function listAccountWhatsAppCampaigns(user,input={},options={}){
 const org=actor(user),ctx=context(options);if(!await accountWhatsAppCampaignsReady(ctx.db))return {items:[],next_cursor:null,schema_ready:false,error:'Run migration 251_account_whatsapp_campaigns to enable campaigns'};
 const limit=bounded(input.limit,20,50);const cursor=input.cursor?positive(input.cursor):null;
 const term=clean(input.search??input.q).slice(0,120);const search=term?`%${term.replace(/[\\%_]/g,'\\$&')}%`:'';
 const {rows}=await ctx.db.query(`${META_SELECT} WHERE c.organization_id=$1 AND ($2::bigint IS NULL OR c.id<$2) AND ($3='' OR c.title ILIKE $3 ESCAPE '\\' OR c.body ILIKE $3 ESCAPE '\\') ORDER BY c.id DESC LIMIT $4`,[org,cursor,search,limit+1]);
 const items=rows.slice(0,limit);const stats=await counts(ctx.db,items.map(r=>r.id));return {items:items.map(r=>view(r,null,stats.get(String(r.id)),ctx)),next_cursor:rows.length>limit?String(items.at(-1).id):null,schema_ready:true};
}
export async function createAccountWhatsAppCampaign(user,input={},options={}){
 const org=actor(user),ctx=context(options);await requireSchema(ctx.db);const d=draft(input);await checkSites(ctx.db,org,d.site_ids);
 const {rows:[row]}=await ctx.db.query(`INSERT INTO account_whatsapp_campaigns(organization_id,sender_id,title,body,footer,language,scope,site_ids,created_by,updated_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$9) RETURNING id`,[org,ctx.senderId,d.title,d.body,d.footer,d.language,d.scope,d.site_ids,user.id]);
 return detail(ctx,org,row.id);
}
export async function getAccountWhatsAppCampaign(user,id,options={}){const org=actor(user),ctx=context(options);await requireSchema(ctx.db);return detail(ctx,org,id);}
export async function updateAccountWhatsAppCampaign(user,id,input={},options={}){
 const org=actor(user),ctx=context(options);await requireSchema(ctx.db);
 await tx(ctx.db,async db=>{const row=await load(db,org,id,true);if(!EDITABLE.has(row.status))throw fail('Queued campaigns are immutable. Create a new draft for a different message.',409);
  const a=await audience(db,org,row.site_ids,row.sender_id||ctx.senderId,{fresh:true});assertRevision(input,row,a);
  const d=draft(input,row);await checkSites(db,org,d.site_ids);
  await db.query(`UPDATE account_whatsapp_campaigns SET title=$3,body=$4,footer=$5,language=$6,scope=$7,site_ids=$8,status='DRAFT',template_name=NULL,meta_template_id=NULL,template_status=NULL,template_definition=NULL,template_error=NULL,template_category='MARKETING',revision=revision+1,updated_by=$9,updated_at=now() WHERE id=$1 AND organization_id=$2`,[row.id,org,d.title,d.body,d.footer,d.language,d.scope,d.site_ids,user.id]);
 });invalidateAudience(ctx.db);return detail(ctx,org,id);
}
export async function saveAccountWhatsAppCampaignDocument(user,id,file,input={},options={}){
 const org=actor(user),ctx=context(options);await requireSchema(ctx.db);const bytes=file?.buffer??file;
 if(!Buffer.isBuffer(bytes)||bytes.length<8||bytes.length>CAMPAIGN_DOCUMENT_MAX_BYTES||!bytes.subarray(0,5).equals(Buffer.from('%PDF-')))throw fail('Attach a valid PDF of up to 20 MB');
 await tx(ctx.db,async db=>{const row=await load(db,org,id,true);if(!EDITABLE.has(row.status))throw fail('The attachment is frozen for this campaign',409);
  const a=await audience(db,org,row.site_ids,row.sender_id||ctx.senderId,{fresh:true});assertRevision(input,row,a);
  await db.query(`INSERT INTO account_whatsapp_campaign_documents(campaign_id,filename,mime_type,size,sha256,content) VALUES($1,'INVITATION.pdf','application/pdf',$2,$3,$4) ON CONFLICT(campaign_id) DO UPDATE SET filename=EXCLUDED.filename,mime_type=EXCLUDED.mime_type,size=EXCLUDED.size,sha256=EXCLUDED.sha256,content=EXCLUDED.content,created_at=now()`,[row.id,bytes.length,sha(bytes),bytes]);
  await db.query(`UPDATE account_whatsapp_campaigns SET status='DRAFT',template_name=NULL,meta_template_id=NULL,template_status=NULL,template_definition=NULL,template_error=NULL,template_category='MARKETING',delivery_media_id=NULL,delivery_media_at=NULL,revision=revision+1,updated_by=$2,updated_at=now() WHERE id=$1`,[row.id,user.id]);
 });return detail(ctx,org,id);
}
export async function downloadAccountWhatsAppCampaignDocument(user,id,options={}){
 const org=actor(user),ctx=context(options);await requireSchema(ctx.db);
 const {rows:[row]}=await ctx.db.query(`SELECT d.content,d.size,d.sha256 FROM account_whatsapp_campaign_documents d JOIN account_whatsapp_campaigns c ON c.id=d.campaign_id WHERE c.id=$1 AND c.organization_id=$2`,[positive(id),org]);
 if(!row)throw fail('Attach INVITATION.pdf first',404);return {buffer:Buffer.from(row.content),filename:CAMPAIGN_DOCUMENT_FILENAME,mime_type:'application/pdf',size:row.size,sha256:row.sha256};
}
export async function previewAccountWhatsAppCampaignAudience(user,id,input={},options={}){
 const org=actor(user),ctx=context(options);await requireSchema(ctx.db);const row=await load(ctx.db,org,id);const limit=bounded(input.limit,50,100);const cursor=clean(input.cursor);if(cursor&&!/^\+91[6-9]\d{9}$/.test(cursor))throw fail('Invalid audience cursor');
 if(ACTIVE.has(row.status)){
  const {rows}=await ctx.db.query(`SELECT phone,full_name,site_ids,member_ids,status FROM account_whatsapp_campaign_recipients WHERE campaign_id=$1 AND organization_id=$2 AND ($3='' OR phone>$3) ORDER BY phone LIMIT $4`,[row.id,org,cursor,limit+1]);
  const items=rows.slice(0,limit);return {count:row.frozen_payload?.recipient_count||0,items,next_cursor:rows.length>limit?items.at(-1).phone:null,excluded_count:row.frozen_payload?.excluded_count||0,revision:revision(row,null),frozen:true};
 }
 const a=await audience(ctx.db,org,row.site_ids,row.sender_id||ctx.senderId,{fresh:input.refresh===true||input.refresh==='true'});const matches=a.items.filter(v=>!cursor||v.phone>cursor);const items=matches.slice(0,limit);
 return {count:a.count,items,next_cursor:matches.length>limit?items.at(-1).phone:null,source_count:a.source_count,invalid_count:a.invalid_count,blocked_count:a.blocked_count,opted_out_count:a.opted_out_count,duplicate_count:a.duplicate_count,excluded_count:a.excluded_count,revision:revision(row,a),frozen:false};
}
function templateState(remote){return clean(remote?.status??remote?.templateStatus??'PENDING').toUpperCase();}
function assertProviderDefinition(row,remote,{approved=true}={}){
 if(approved&&templateState(remote)!=='APPROVED')throw fail('Meta has not approved this invitation template',409);
 if(clean(remote.category??remote.templateCategory).toUpperCase()!=='MARKETING')throw fail('The approved invitation must remain a Marketing template',409);
 const expected=row.template_definition;const components=remote.components||[];
 const allowed=new Set(['HEADER','BODY',...(row.footer?['FOOTER']:[])]);
 if(components.length!==allowed.size||components.some(c=>!allowed.has(clean(c.type).toUpperCase()))||[...allowed].some(type=>components.filter(c=>clean(c.type).toUpperCase()===type).length!==1))throw fail('The provider template components changed. Review a new campaign version.',409);
 const header=components.find(c=>clean(c.type).toUpperCase()==='HEADER');const body=components.find(c=>clean(c.type).toUpperCase()==='BODY');const footer=components.find(c=>clean(c.type).toUpperCase()==='FOOTER');
 if(clean(remote.name??remote.templateName)!==row.template_name||clean(remote.language)!==row.language||clean(header?.format).toUpperCase()!=='DOCUMENT'||body?.text!==expected?.components?.find(c=>c.type==='BODY')?.text||(footer?.text||'')!==(row.footer||''))throw fail('The provider template changed. Create and review a new campaign version.',409);
}
export async function submitAccountWhatsAppCampaignTemplate(user,id,input={},options={}){
 const org=actor(user),ctx=context(options);await requireSchema(ctx.db);if(!ctx.configured)throw fail('Configure the WhatsApp sender before submitting to Meta',409);
 let submission;
 await tx(ctx.db,async db=>{const row=await load(db,org,id,true);if(!EDITABLE.has(row.status))throw fail('This campaign cannot be submitted in its current state',409);
  const a=await audience(db,org,row.site_ids,row.sender_id||ctx.senderId,{fresh:true});assertRevision(input,row,a);
  if(!row.document_sha256)throw fail('Attach INVITATION.pdf before requesting Meta approval',409);
  const compiled=compileAccountWhatsAppCampaign(row.body,row.footer);const doc=(await db.query('SELECT content FROM account_whatsapp_campaign_documents WHERE campaign_id=$1',[row.id])).rows[0];
  const name=`dgg_invitation_${row.id}_${randomUUID().replaceAll('-','').slice(0,12)}`;
  await db.query(`UPDATE account_whatsapp_campaigns SET sender_id=$2,status='SUBMITTING',template_name=$3,meta_template_id=NULL,template_status='SUBMITTING',template_error=NULL,template_category='MARKETING',submitted_at=now(),updated_by=$4,updated_at=now() WHERE id=$1`,[row.id,ctx.senderId,name,user.id]);
  submission={row:{...row,template_name:name,sender_id:ctx.senderId},compiled,buffer:Buffer.from(doc.content)};
 });
 try{
  const handle=await ctx.uploadTemplate(submission.buffer,CAMPAIGN_DOCUMENT_FILENAME);if(!clean(handle))throw fail('The provider did not return a document approval handle',502);
  const definition={name:submission.row.template_name,language:submission.row.language,category:'MARKETING',allow_category_change:false,parameter_format:'positional',components:[{type:'HEADER',format:'DOCUMENT',example:{header_handle:[handle]}},{type:'BODY',text:submission.compiled.text,...(submission.compiled.fields.length?{example:{body_text:[submission.compiled.fields.map(()=>submission.row.language==='hi'?'राहुल शर्मा':'Rahul Sharma')]}}:{})},...(submission.compiled.footer?[{type:'FOOTER',text:submission.compiled.footer}]:[])]};
  const remote=await ctx.transport.create(definition);const status=templateState(remote);const category=clean(remote.category??remote.templateCategory??'MARKETING').toUpperCase();
  await ctx.db.query(`UPDATE account_whatsapp_campaigns SET status=$2,template_status=$3,template_category=$4,meta_template_id=$5,template_definition=$6::jsonb,template_error=$7,updated_at=now() WHERE id=$1 AND status='SUBMITTING' AND template_name=$8`,[submission.row.id,status==='APPROVED'&&category==='MARKETING'?'APPROVED':status==='REJECTED'?'REJECTED':'PENDING',status,category,remote.metaTemplateId??remote.id??null,JSON.stringify(definition),category!=='MARKETING'?'Meta changed the category; this invitation cannot be sent':null,submission.row.template_name]);
 }catch(error){await ctx.db.query(`UPDATE account_whatsapp_campaigns SET status='SUBMISSION_FAILED',template_status='SUBMISSION_FAILED',template_error=$2,updated_at=now() WHERE id=$1 AND status='SUBMITTING' AND template_name=$3`,[submission.row.id,String(error.message).slice(0,1000),submission.row.template_name]);throw fail(`Draft retained; Meta submission failed: ${error.message}`,error.status||422);}
 return detail(ctx,org,id);
}
export async function refreshAccountWhatsAppCampaignTemplate(user,id,input={},options={}){
 const org=actor(user),ctx=context(options);await requireSchema(ctx.db);const row=await load(ctx.db,org,id);if(!row.meta_template_id)throw fail('Submit this invitation to Meta first',409);
 const remote=await ctx.transport.get(row.meta_template_id);let status=templateState(remote),category=clean(remote.category??remote.templateCategory??'').toUpperCase(),error=null;
 if(status==='APPROVED'){try{assertProviderDefinition(row,remote);}catch(e){status='CHANGED';error=e.message;}}
 await ctx.db.query(`UPDATE account_whatsapp_campaigns SET template_status=$3,template_category=$4,template_error=$5,status=CASE WHEN status IN ('DRAFT','SUBMITTING','PENDING','APPROVED','REJECTED','SUBMISSION_FAILED') THEN CASE WHEN $3='APPROVED' THEN 'APPROVED' WHEN $3='REJECTED' THEN 'REJECTED' ELSE 'PENDING' END ELSE status END,updated_at=now() WHERE id=$1 AND organization_id=$2 AND meta_template_id=$6`,[row.id,org,status,category,error,row.meta_template_id]);return detail(ctx,org,id);
}
function sendKey(input){const key=clean(input.idempotency_key);if(!/^[A-Za-z0-9_.:-]{8,160}$/.test(key))throw fail('A valid send idempotency key is required');return key;}
export async function sendAccountWhatsAppCampaign(user,id,input={},options={}){
 const org=actor(user),ctx=context(options);await requireSchema(ctx.db);const key=sendKey(input);
 if(input.consent_confirmed!==true||input.confirmation!=='SEND')throw fail('Confirm the reviewed audience and consent before sending',409);
 if(!ctx.configured||!ctx.enabled)throw fail('The WhatsApp sender must be configured and enabled before sending',409);
 const current=await load(ctx.db,org,id);
 if(current.send_idempotency_key===key&&['QUEUED','SENDING','COMPLETED'].includes(current.status))return detail(ctx,org,id);
 if(!['APPROVED','PAUSED'].includes(current.status)||current.template_status!=='APPROVED'||!current.meta_template_id)throw fail('Wait for Meta approval before manually sending this campaign',409);
 if(current.sender_id!==ctx.senderId)throw fail('The configured sender differs from the approved invitation sender',409);
 assertProviderDefinition(current,await ctx.transport.get(current.meta_template_id));
 await tx(ctx.db,async db=>{const row=await load(db,org,id,true);
  if(row.send_idempotency_key===key&&['QUEUED','SENDING','COMPLETED'].includes(row.status))return;
  if(!['APPROVED','PAUSED'].includes(row.status)||row.template_status!=='APPROVED'||row.revision!==current.revision||row.template_name!==current.template_name)throw fail('The campaign changed during review. Refresh before sending.',409);
  if(row.status==='PAUSED'&&row.frozen_payload){assertRevision(input,row,null);await db.query("UPDATE account_whatsapp_campaigns SET status='QUEUED',send_idempotency_key=$3,updated_by=$2,updated_at=now() WHERE id=$1",[row.id,user.id,key]);return;}
  const a=await audience(db,org,row.site_ids,row.sender_id,{fresh:true});assertRevision(input,row,a);if(!a.count)throw fail('The audience has no eligible WhatsApp numbers',409);if(!row.document_sha256)throw fail('Attach INVITATION.pdf first',409);
  const compiled=compileAccountWhatsAppCampaign(row.body,row.footer);
  const recipients=a.items.map(item=>({...item,rendered_body:row.body.replaceAll('{customer_name}',item.full_name),parameters:compiled.fields.map(()=>item.full_name)}));
  await db.query(`INSERT INTO account_whatsapp_campaign_recipients(campaign_id,organization_id,phone,full_name,site_ids,member_ids,rendered_body,parameters) SELECT $1,$2,x.phone,x.full_name,x.site_ids,x.member_ids,x.rendered_body,x.parameters FROM jsonb_to_recordset($3::jsonb) AS x(phone text,full_name text,site_ids int[],member_ids int[],rendered_body text,parameters jsonb) ON CONFLICT(campaign_id,phone) DO NOTHING`,[row.id,org,JSON.stringify(recipients)]);
  const frozen={template_name:row.template_name,meta_template_id:row.meta_template_id,language:row.language,body:row.body,footer:row.footer,document_sha256:row.document_sha256,document_filename:CAMPAIGN_DOCUMENT_FILENAME,template_definition:row.template_definition,recipient_count:a.count,excluded_count:a.excluded_count,audience_fingerprint:a.fingerprint,manual_start_at:nowIso()};
  await db.query(`UPDATE account_whatsapp_campaigns SET status='QUEUED',send_idempotency_key=$2,consent_confirmed_at=now(),frozen_payload=$3::jsonb,queued_at=COALESCE(queued_at,now()),updated_by=$4,updated_at=now() WHERE id=$1`,[row.id,key,JSON.stringify(frozen),user.id]);
 });return detail(ctx,org,id);
}
export async function pauseAccountWhatsAppCampaign(user,id,input={},options={}){
 const org=actor(user),ctx=context(options);await requireSchema(ctx.db);
 await tx(ctx.db,async db=>{const row=await load(db,org,id,true);if(!['QUEUED','SENDING','PAUSED'].includes(row.status))throw fail('Only a running or queued campaign can be paused',409);assertRevision(input,row,null);await db.query("UPDATE account_whatsapp_campaigns SET status='PAUSED',updated_by=$2,updated_at=now() WHERE id=$1",[row.id,user.id]);});return detail(ctx,org,id);
}
async function isOptedOut(db,org,senderId,phone){
 if(await optionalTable(db,'account_whatsapp_opt_outs')){if((await db.query('SELECT 1 FROM account_whatsapp_opt_outs WHERE organization_id=$1 AND sender_id=$2 AND phone=ANY($3::text[]) AND active=true',[org,senderId,[phone,phone.slice(1)]])).rows.length)return true;}
 if(await optionalTable(db,'whatsapp_opt_outs')){if((await db.query("SELECT 1 FROM whatsapp_opt_outs WHERE RIGHT(REGEXP_REPLACE(phone,'[^0-9]','','g'),10)=$1",[phone.slice(-10)])).rows.length)return true;}
 return false;
}
async function recordAccepted(ctx,row,payload,providerId){const record=ctx.recordOutbound||(await import('./accountWhatsAppInbox.service.js')).recordAccountWhatsAppCampaignOutbound;await record({organization_id:row.organization_id,campaign_id:row.campaign_id,recipient_id:row.id,phone:row.phone,full_name:row.full_name,body:row.rendered_body,provider_message_id:providerId,status:['DELIVERED','READ','FAILED'].includes(row.status)?row.status:'SENT',sent_at:row.sent_at||nowIso(),document:{filename:CAMPAIGN_DOCUMENT_FILENAME},sender_id:ctx.senderId},{db:ctx.db});}
async function prepareMedia(ctx,campaign){
 if(campaign.delivery_media_id&&campaign.delivery_media_at&&Date.now()-new Date(campaign.delivery_media_at).getTime()<23*60*60*1000)return campaign.delivery_media_id;
 const {rows:[doc]}=await ctx.db.query('SELECT content,sha256 FROM account_whatsapp_campaign_documents WHERE campaign_id=$1',[campaign.id]);
 if(!doc||doc.sha256!==campaign.frozen_payload?.document_sha256)throw fail('The frozen invitation attachment is unavailable',409);
 const id=await ctx.upload(Buffer.from(doc.content),CAMPAIGN_DOCUMENT_FILENAME);if(!clean(id))throw fail('The provider did not return an attachment media ID',502);
 await ctx.db.query('UPDATE account_whatsapp_campaigns SET delivery_media_id=$2,delivery_media_at=now() WHERE id=$1',[campaign.id,id]);return id;
}
/** Advances only explicitly queued campaigns. No template submission, scheduling,
 * accounting-event automation, or uncertain-delivery retries occur here. */
export async function drainAccountWhatsAppCampaigns(options={}){
 const ctx=context(options);if(!ctx.configured||!ctx.enabled||!await accountWhatsAppCampaignsReady(ctx.db))return {processed:0};
 const max=bounded(options.max,10,50);const spacing=Math.max(0,Math.min(5000,options.spacing_ms??250));let processed=0;
 await ctx.db.query("UPDATE account_whatsapp_campaign_recipients r SET status='UNKNOWN',error='Send interrupted; verify provider delivery before any manual follow-up',updated_at=now() FROM account_whatsapp_campaigns c WHERE r.campaign_id=c.id AND c.sender_id=$1 AND r.status='SENDING' AND r.updated_at<now()-interval '10 minutes'",[ctx.senderId]);
 // Recover only the local inbox projection after provider acceptance. These
 // rows are never passed to the send transport again.
 const {rows:pendingInbox}=await ctx.db.query("SELECT r.*,c.frozen_payload FROM account_whatsapp_campaign_recipients r JOIN account_whatsapp_campaigns c ON c.id=r.campaign_id WHERE c.sender_id=$1 AND r.provider_message_id IS NOT NULL AND r.status IN ('SENT','DELIVERED','READ','FAILED') AND r.error LIKE 'Accepted by provider; inbox sync pending:%' ORDER BY r.id LIMIT 10",[ctx.senderId]);
 for(const row of pendingInbox){try{await recordAccepted(ctx,row,row.frozen_payload,row.provider_message_id);await ctx.db.query("UPDATE account_whatsapp_campaign_recipients SET error=NULL WHERE id=$1 AND error LIKE 'Accepted by provider; inbox sync pending:%'",[row.id]);}catch{/* A later bounded tick retries this database projection only. */}}
 // Claim a campaign with a session-scoped advisory lock. Network I/O never
 // occupies a database transaction; another worker skips the busy campaign.
 const {rows:candidates}=await ctx.db.query("SELECT id FROM account_whatsapp_campaigns WHERE status IN ('QUEUED','SENDING') AND sender_id=$1 ORDER BY id LIMIT 20",[ctx.senderId]);
 for(const candidate of candidates){if(processed>=max)break;const lock=await ctx.db.connect();let locked=false;
  try{
   locked=Boolean((await lock.query('SELECT pg_try_advisory_lock(hashtext($1)) AS locked',[`account-whatsapp-campaign:${candidate.id}`])).rows[0]?.locked);if(!locked)continue;
   const {rows:[campaign]}=await ctx.db.query("SELECT * FROM account_whatsapp_campaigns WHERE id=$1 AND status IN ('QUEUED','SENDING')",[candidate.id]);if(!campaign)continue;
   try{assertProviderDefinition(campaign,await ctx.transport.get(campaign.meta_template_id));}catch(error){await ctx.db.query("UPDATE account_whatsapp_campaigns SET status='PAUSED',template_error=$2,updated_at=now() WHERE id=$1",[campaign.id,String(error.message).slice(0,1000)]);continue;}
   let mediaId;try{mediaId=await prepareMedia(ctx,campaign);}catch(error){await ctx.db.query("UPDATE account_whatsapp_campaigns SET status='PAUSED',template_error=$2,updated_at=now() WHERE id=$1",[campaign.id,String(error.message).slice(0,1000)]);continue;}
   await ctx.db.query("UPDATE account_whatsapp_campaigns SET status='SENDING',started_at=COALESCE(started_at,now()),updated_at=now() WHERE id=$1 AND status='QUEUED'",[campaign.id]);
   while(processed<max){
    const row=await tx(ctx.db,async db=>{const {rows:[c]}=await db.query('SELECT status FROM account_whatsapp_campaigns WHERE id=$1 FOR UPDATE',[campaign.id]);if(!c||!['QUEUED','SENDING'].includes(c.status))return null;const {rows:[r]}=await db.query("SELECT * FROM account_whatsapp_campaign_recipients WHERE campaign_id=$1 AND status='QUEUED' ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1",[campaign.id]);if(!r)return null;await db.query("UPDATE account_whatsapp_campaign_recipients SET status='SENDING',updated_at=now() WHERE id=$1",[r.id]);return r;});
    if(!row)break;processed++;
    if(await isOptedOut(ctx.db,row.organization_id,ctx.senderId,row.phone)){await ctx.db.query("UPDATE account_whatsapp_campaign_recipients SET status='SKIPPED',error='Recipient opted out',updated_at=now() WHERE id=$1",[row.id]);continue;}
    let providerId;
    try{
     providerId=await ctx.send(row.phone,campaign.frozen_payload.template_name,row.parameters,{language:campaign.frozen_payload.language,ref:`account-campaign:${row.id}`,media:{id:mediaId,filename:CAMPAIGN_DOCUMENT_FILENAME}});
     if(!clean(providerId))throw fail('The provider response did not confirm message acceptance',502);
     const {rows:[accepted]}=await ctx.db.query("UPDATE account_whatsapp_campaign_recipients SET status=CASE WHEN status IN ('DELIVERED','READ','FAILED') THEN status ELSE 'SENT' END,provider_message_id=$2,sent_at=COALESCE(sent_at,now()),updated_at=now() WHERE id=$1 RETURNING sent_at,status",[row.id,providerId]);
     // Inbox persistence can be retried independently; it must never re-send.
     try{await recordAccepted(ctx,{...row,...accepted},campaign.frozen_payload,providerId);}catch(error){await ctx.db.query('UPDATE account_whatsapp_campaign_recipients SET error=$2 WHERE id=$1',[row.id,`Accepted by provider; inbox sync pending: ${String(error.message).slice(0,700)}`]);}
    }catch(error){
     if(clean(providerId)){
      // A confirmed provider acceptance survives a transient local write
      // failure. Retry only the idempotent persistence, never the transport.
      await ctx.db.query("UPDATE account_whatsapp_campaign_recipients SET status=CASE WHEN status IN ('DELIVERED','READ','FAILED') THEN status ELSE 'SENT' END,provider_message_id=$2,sent_at=COALESCE(sent_at,now()),error=$3,updated_at=now() WHERE id=$1",[row.id,providerId,`Accepted by provider; inbox sync pending: ${String(error.message).slice(0,700)}`]);
     }else{
      const definite=error?.$metadata?.httpStatusCode>=400&&error?.$metadata?.httpStatusCode<500&&!['ThrottlingException','TooManyRequestsException'].includes(error.name);await ctx.db.query("UPDATE account_whatsapp_campaign_recipients SET status=CASE WHEN status IN ('DELIVERED','READ','FAILED') THEN status ELSE $2 END,error=$3,updated_at=now() WHERE id=$1",[row.id,definite?'FAILED':'UNKNOWN',String(error.message).slice(0,1000)]);
     }
    }
    if(spacing&&processed<max)await new Promise(resolve=>setTimeout(resolve,spacing));
   }
   await ctx.db.query("UPDATE account_whatsapp_campaigns c SET status='COMPLETED',completed_at=now(),updated_at=now() WHERE c.id=$1 AND c.status IN ('QUEUED','SENDING') AND NOT EXISTS(SELECT 1 FROM account_whatsapp_campaign_recipients r WHERE r.campaign_id=c.id AND r.status IN ('QUEUED','SENDING'))",[campaign.id]);
  }finally{if(locked)await lock.query('SELECT pg_advisory_unlock(hashtext($1))',[`account-whatsapp-campaign:${candidate.id}`]).catch(()=>{});lock.release();}
 }
 return {processed};
}
