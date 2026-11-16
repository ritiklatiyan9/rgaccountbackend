import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { up } from '../src/migrations/251_account_whatsapp_campaigns.js';
import {
 createAccountWhatsAppCampaign as create, getAccountWhatsAppCampaign as get,
 listAccountWhatsAppCampaigns as list, updateAccountWhatsAppCampaign as edit,
 saveAccountWhatsAppCampaignDocument as attach, downloadAccountWhatsAppCampaignDocument as download,
 previewAccountWhatsAppCampaignAudience as audience, submitAccountWhatsAppCampaignTemplate as submit,
 refreshAccountWhatsAppCampaignTemplate as refresh, sendAccountWhatsAppCampaign as start,
 pauseAccountWhatsAppCampaign as pause, drainAccountWhatsAppCampaigns as drain,
 compileAccountWhatsAppCampaign as compile,
} from '../src/services/accountWhatsAppCampaigns.service.js';
const ADMIN={id:1,role:'admin',organization_id:1};
const PDF=Buffer.from('%PDF-1.4\nFictional attachment for isolated tests\n%%EOF');
async function fixture(t){
 const pg=new PGlite();
 await pg.exec(`CREATE TABLE users(id integer PRIMARY KEY);INSERT INTO users VALUES(1);
 CREATE TABLE sites(id integer PRIMARY KEY,name text,organization_id integer);
 INSERT INTO sites VALUES(1,'Site One',1),(2,'Site Two',1),(3,'Other Company',2);
 CREATE TABLE members(id integer PRIMARY KEY,site_id integer,full_name text,phone text,alt_phone text,whatsapp text,status text);
 INSERT INTO members VALUES
 (1,1,'Rahul Sharma','9876543210',NULL,NULL,'ACTIVE'),
 (2,2,'Rahul Sharma','9876543210',NULL,'+91 98765 43210','ACTIVE'),
 (3,1,'Primary fallback','8765432109','7654321098','C92','ACTIVE'),
 (4,2,'Alternate fallback','bad','7654321098',NULL,'ACTIVE'),
 (5,1,'Invalid number','12345',NULL,NULL,'ACTIVE'),
 (6,1,'Blocked client','9999999999',NULL,NULL,'BLOCKED'),
 (7,1,'Legacy optout','9123456780',NULL,NULL,'ACTIVE'),
 (8,2,'Inbox optout','9234567890',NULL,NULL,'ACTIVE'),
 (9,3,'Other company private','9345678901',NULL,NULL,'ACTIVE'),
 (10,1,'Preferred WhatsApp','9567890123','9678901234','9456789012','ACTIVE');
 CREATE TABLE whatsapp_opt_outs(phone text PRIMARY KEY);INSERT INTO whatsapp_opt_outs VALUES('+919123456780');
 CREATE TABLE account_whatsapp_opt_outs(organization_id integer,sender_id text,phone text,active boolean,PRIMARY KEY(organization_id,sender_id,phone));
 INSERT INTO account_whatsapp_opt_outs VALUES(1,'sender-test','+919234567890',true);
 CREATE FUNCTION pg_advisory_xact_lock(integer) RETURNS void LANGUAGE SQL AS $$SELECT$$;`);
 const query=(sql,args=[])=>args.length?pg.query(sql,args):pg.exec(sql).then(rs=>rs.at(-1));
 let tail=Promise.resolve();const locks=new Map();
 const db={query,connect:async()=>{
  let release;
  const c={query:async(sql,args=[])=>{
   if(/^BEGIN\b/.test(sql)){const before=tail;tail=new Promise(resolve=>{release=resolve;});await before;}
   if(sql.startsWith('SELECT pg_try_advisory_lock')){const locked=locks.has(args[0]);if(!locked)locks.set(args[0],c);return {rows:[{locked:!locked}]};}
   if(sql.startsWith('SELECT pg_advisory_unlock')){if(locks.get(args[0])===c)locks.delete(args[0]);return {rows:[{}]};}
   try{return await query(sql,args);}finally{if(/^(COMMIT|ROLLBACK)\b/.test(sql)&&release){release();release=null;}}
  },release(){if(release){release();release=null;}}};return c;
 }};
 await up(db);
 const calls={create:0,upload:0,send:0,record:0};const definitions=new Map(),deliveries=[];
 const transport={
  uploadTemplateMedia:async(bytes,filename)=>{assert.deepEqual(bytes,PDF);assert.equal(filename,'INVITATION.pdf');calls.upload++;return 'approval-handle';},
  create:async definition=>{calls.create++;definitions.set('meta-'+calls.create,{...definition,status:'PENDING'});return {metaTemplateId:'meta-'+calls.create,templateStatus:'PENDING',category:'MARKETING'};},
  get:async id=>structuredClone(definitions.get(id)),
 };
 const opts={db,transport,sender_id:'sender-test',configured:true,enabled:true,spacing_ms:0,
  upload:async(bytes,filename)=>{assert.deepEqual(bytes,PDF);assert.equal(filename,'INVITATION.pdf');calls.upload++;return 'delivery-media';},
  send:async(phone,name,params,options)=>{calls.send++;deliveries.push({phone,name,params,options});return 'provider-'+calls.send;},
  recordOutbound:async row=>{calls.record++;assert.equal(row.document.filename,'INVITATION.pdf');assert.ok(Number.isFinite(new Date(row.sent_at).getTime()),'the persisted acceptance timestamp reaches the inbox');},
 };
 t.after(()=>pg.close());return {db,pg,opts,calls,definitions,deliveries};
}
async function draft(f){return create(ADMIN,{title:'Office invitation',body:'Dear {customer_name}, please join our celebration.',footer:'Reply STOP to unsubscribe.',language:'en'},f.opts);}
async function attached(f){const c=await draft(f);return attach(ADMIN,c.id,{buffer:PDF},{revision:c.revision},f.opts);}
async function approved(f){let c=await attached(f);c=await submit(ADMIN,c.id,{revision:c.revision},f.opts);f.definitions.get(c.meta_template_id).status='APPROVED';return refresh(ADMIN,c.id,{},f.opts);}
const consent=(c,key='manual-send-test-001')=>({revision:c.revision,idempotency_key:key,consent_confirmed:true,confirmation:'SEND'});

test('draft/list/detail/audience reads have no provider side effects; audience uses one valid destination per number across all sites',async t=>{
 const f=await fixture(t),c=await draft(f);const a=await audience(ADMIN,c.id,{limit:2},f.opts);const b=await audience(ADMIN,c.id,{cursor:a.next_cursor},f.opts);
 assert.equal(a.count,4);assert.equal(a.source_count,9);assert.equal(a.invalid_count,1);assert.equal(a.blocked_count,1);assert.equal(a.opted_out_count,2);assert.equal(a.duplicate_count,1);
 const rows=[...a.items,...b.items];assert.deepEqual(rows.map(x=>x.phone),['+917654321098','+918765432109','+919456789012','+919876543210']);assert.deepEqual(rows.at(-1).site_ids,[1,2]);assert.deepEqual(rows.at(-1).member_ids,[1,2]);
 assert.equal((await list(ADMIN,{},f.opts)).items.length,1);assert.equal(c.document,null);assert.ok(c.blockers.some(x=>x.includes('INVITATION.pdf')));
 assert.deepEqual(f.calls,{create:0,upload:0,send:0,record:0});assert.equal((await f.db.query('SELECT count(*)::int AS n FROM account_whatsapp_campaign_recipients')).rows[0].n,0);
});

test('organization/admin scope protects campaign, attachment, audience and selected-site IDs',async t=>{
 const f=await fixture(t),c=await attached(f),other={...ADMIN,organization_id:2};
 for(const fn of [()=>get(other,c.id,f.opts),()=>download(other,c.id,f.opts),()=>audience(other,c.id,{},f.opts)])await assert.rejects(fn,e=>e.status===404);
 await assert.rejects(create({...ADMIN,role:'sub_admin'},{title:'No access'},f.opts),e=>e.status===403);
 await assert.rejects(create(ADMIN,{title:'Wrong site',site_ids:[3]},f.opts),e=>e.status===403);
 const filtered=await create(ADMIN,{title:'Site two only',site_ids:[2]},f.opts);assert.deepEqual((await audience(ADMIN,filtered.id,{},f.opts)).items.map(x=>x.phone),['+917654321098','+919876543210']);
});

test('attachment is private, PDF validated, filename fixed and stale revisions cannot edit content',async t=>{
 const f=await fixture(t),original=await draft(f);
 await assert.rejects(attach(ADMIN,original.id,{buffer:Buffer.from('not PDF')},{revision:original.revision},f.opts),/valid PDF/);
 const c=await attach(ADMIN,original.id,{buffer:PDF,originalname:'wrong.pdf'},{revision:original.revision},f.opts);assert.equal(c.document.filename,'INVITATION.pdf');assert.equal(c.document.size,PDF.length);assert.equal('content'in c.document,false);
 const doc=await download(ADMIN,c.id,f.opts);assert.deepEqual(doc.buffer,PDF);assert.equal(doc.filename,'INVITATION.pdf');
 await assert.rejects(edit(ADMIN,c.id,{body:'Stale change',revision:original.revision},f.opts),e=>e.status===409);
 const updated=await edit(ADMIN,c.id,{body:'A revised invitation.',revision:c.revision},f.opts);assert.notEqual(updated.revision,c.revision);assert.equal(updated.status,'DRAFT');
});

test('explicit Meta submission uses MARKETING + DOCUMENT + footer; approval alone never queues recipients',async t=>{
 const f=await fixture(t);let c=await attached(f);await assert.rejects(start(ADMIN,c.id,consent(c),f.opts),/Meta approval/);
 c=await submit(ADMIN,c.id,{revision:c.revision},f.opts);const remote=f.definitions.get(c.meta_template_id);assert.equal(remote.category,'MARKETING');assert.equal(remote.allow_category_change,false);assert.equal(remote.components[0].format,'DOCUMENT');assert.equal(remote.components[1].text,'Dear {{1}}, please join our celebration.');assert.equal(remote.components[2].text,'Reply STOP to unsubscribe.');assert.equal(c.status,'PENDING');
 remote.status='APPROVED';c=await refresh(ADMIN,c.id,{},f.opts);assert.equal(c.status,'APPROVED');assert.deepEqual(f.calls,{create:1,upload:1,send:0,record:0});assert.equal((await f.db.query('SELECT COUNT(*)::int AS n FROM account_whatsapp_campaign_recipients')).rows[0].n,0);
});

test('manual send freezes exactly one recipient per destination; idempotent repeat never queues or sends twice',async t=>{
 const f=await fixture(t);let c=await approved(f);await assert.rejects(start(ADMIN,c.id,{...consent(c),confirmation:'NO'},f.opts),/Confirm/);
 const request=consent(c);c=await start(ADMIN,c.id,request,f.opts);assert.equal(c.status,'QUEUED');assert.equal(c.stats.queued,4);assert.equal((await start(ADMIN,c.id,request,f.opts)).stats.queued,4);assert.equal(f.calls.send,0);
 await assert.rejects(edit(ADMIN,c.id,{title:'Mutate queued',revision:c.revision},f.opts),/immutable/);
 assert.equal((await drain({...f.opts,max:20})).processed,4);assert.equal(f.calls.send,4);assert.equal(f.calls.record,4);assert.equal(f.calls.upload,2);assert.equal(new Set(f.deliveries.map(x=>x.phone)).size,4);
 for(const d of f.deliveries){assert.equal(d.options.media.filename,'INVITATION.pdf');assert.match(d.options.ref,/^account-campaign:\d+$/);}
 const done=await get(ADMIN,c.id,f.opts);assert.equal(done.status,'COMPLETED');assert.equal(done.stats.sent,4);assert.equal((await drain(f.opts)).processed,0);await start(ADMIN,c.id,request,f.opts);assert.equal(f.calls.send,4);
});

test('changed audience invalidates reviewed revision; opt-outs arriving after queue are checked again before sending',async t=>{
 const f=await fixture(t);let c=await approved(f);await f.db.query("INSERT INTO members VALUES(20,2,'New recipient','9789012345',NULL,NULL,'ACTIVE')");
 await assert.rejects(start(ADMIN,c.id,consent(c),f.opts),e=>e.status===409);
 const preview=await audience(ADMIN,c.id,{refresh:true},f.opts);c={...c,revision:preview.revision};c=await start(ADMIN,c.id,consent(c),f.opts);assert.equal(c.stats.queued,5);
 await f.db.query("INSERT INTO whatsapp_opt_outs VALUES('+919789012345')");await f.db.query("INSERT INTO account_whatsapp_opt_outs VALUES(1,'sender-test','+919456789012',true)");
 await drain({...f.opts,max:20});const done=await get(ADMIN,c.id,f.opts);assert.equal(done.stats.sent,3);assert.equal(done.stats.skipped,2);
});

test('pause stops unclaimed work; resume is manual and ambiguous errors never retry recipients',async t=>{
 const f=await fixture(t);let c=await approved(f);c=await start(ADMIN,c.id,consent(c),f.opts);c=await pause(ADMIN,c.id,{revision:c.revision},f.opts);assert.equal((await drain(f.opts)).processed,0);
 c=await start(ADMIN,c.id,consent(c,'manual-resume-001'),f.opts);let attempts=0;const opts={...f.opts,send:async()=>{attempts++;throw new Error('Network timed out after submission');}};
 await drain({...opts,max:1});assert.equal((await get(ADMIN,c.id,f.opts)).stats.unknown,1);await drain({...opts,max:20});assert.equal(attempts,4);assert.equal((await get(ADMIN,c.id,f.opts)).status,'COMPLETED');await drain(opts);assert.equal(attempts,4);
});

test('live category/definition drift blocks manual start and pauses queued work',async t=>{
 const f=await fixture(t);let c=await approved(f),remote=f.definitions.get(c.meta_template_id);remote.category='UTILITY';await assert.rejects(start(ADMIN,c.id,consent(c),f.opts),/Marketing/);remote.category='MARKETING';
 c=await start(ADMIN,c.id,consent(c),f.opts);remote.components.find(x=>x.type==='BODY').text='A changed message';await drain({...f.opts,max:20});const after=await get(ADMIN,c.id,f.opts);assert.equal(after.status,'PAUSED');assert.equal(f.calls.send,0);assert.match(after.template_error,/changed/);
});

test('two concurrent manual starts share one frozen audience',async t=>{
 const f=await fixture(t),c=await approved(f),request=consent(c,'concurrent-manual-001');const values=await Promise.all([start(ADMIN,c.id,request,f.opts),start(ADMIN,c.id,request,f.opts)]);assert.equal(values[0].stats.total,4);assert.equal(values[1].stats.total,4);assert.equal((await f.db.query('SELECT COUNT(*)::int AS n FROM account_whatsapp_campaign_recipients')).rows[0].n,4);
});

test('delivery/read race is not downgraded; failed inbox projection repairs without another send',async t=>{
 const f=await fixture(t);let c=await approved(f);c=await start(ADMIN,c.id,consent(c),f.opts);let failRecord=true,sendCount=0;
 const opts={...f.opts,recordOutbound:async()=>{if(failRecord)throw new Error('temporary inbox failure');f.calls.record++;},send:async(phone,name,params,opts)=>{sendCount++;const id=Number(opts.ref.split(':')[1]);await f.db.query("UPDATE account_whatsapp_campaign_recipients SET status='READ',delivered_at=now(),read_at=now() WHERE id=$1",[id]);return 'race-provider-'+sendCount;}};
 await drain({...opts,max:1});let row=(await f.db.query('SELECT * FROM account_whatsapp_campaign_recipients ORDER BY id LIMIT 1')).rows[0];assert.equal(row.status,'READ');assert.match(row.error,/inbox sync pending/);
 failRecord=false;await pause(ADMIN,c.id,{revision:(await get(ADMIN,c.id,f.opts)).revision},f.opts);await drain(opts);row=(await f.db.query('SELECT * FROM account_whatsapp_campaign_recipients ORDER BY id LIMIT 1')).rows[0];assert.equal(row.error,null);assert.equal(sendCount,1);assert.equal(f.calls.record,1);
});

test('stale SENDING repair affects only this worker sender',async t=>{
 const f=await fixture(t);let c=await approved(f);c=await start(ADMIN,c.id,consent(c),f.opts);await f.db.query("UPDATE account_whatsapp_campaign_recipients SET status='SENDING',updated_at=now()-interval '20 minutes'");await f.db.query("UPDATE account_whatsapp_campaigns SET sender_id='different-sender'");await drain(f.opts);assert.equal((await f.db.query("SELECT COUNT(*)::int AS n FROM account_whatsapp_campaign_recipients WHERE status='SENDING'")).rows[0].n,4);
});

test('compiler supports short static Hindi text and rejects unsupported variables or oversized footer',()=>{
 const body='*डिफेंस गार्डन ग्रुप*\nआप सादर आमंत्रित हैं।';assert.equal(compile(body,'STOP लिखें।').text,body);assert.throws(()=>compile('Hello {account_number}'),/customer_name/);assert.throws(()=>compile('Hello','x'.repeat(61)),/footer/);
});

test('real inbound STOP suppresses a queued invitation and all later audience previews; event replay is idempotent',async t=>{
 const f=await fixture(t);
 const {up:inboxUp}=await import('../src/migrations/252_account_whatsapp_inbox.js');
 const {ingestAccountWhatsAppEvent:ingest}=await import('../src/services/accountWhatsAppInbound.service.js');
 await f.db.query('DROP TABLE account_whatsapp_opt_outs');
 await f.db.query('ALTER TABLE whatsapp_opt_outs ADD COLUMN reason text,ADD COLUMN created_by integer');
 await inboxUp(f.db);
 await f.db.query("INSERT INTO account_whatsapp_opt_outs(organization_id,sender_id,phone,active) VALUES(1,'sender-test','+919234567890',true)");
 let c=await approved(f);c=await start(ADMIN,c.id,consent(c),f.opts);assert.equal(c.stats.queued,4);
 const now=new Date(Date.now()+2000);
 const event={aws_account_id:'123456789012',context:{MetaPhoneNumberIds:[{arn:'arn:aws:social-messaging:ap-south-1:123456789012:phone-number-id/sender-test',metaPhoneNumberId:'meta-phone-test'}]},whatsAppWebhookEntry:{id:'waba',changes:[{value:{messaging_product:'whatsapp',metadata:{phone_number_id:'meta-phone-test'},messages:[{id:'wamid.stop.campaign-test',from:'919456789012',timestamp:String(Math.floor(now.getTime()/1000)),type:'text',text:{body:'STOP'}}]}}]}};
 const deps={db:f.db,organizationId:1,senderId:'sender-test',accountId:'123456789012',region:'ap-south-1',eventKey:'isolated-stop-event',now:()=>now};
 const ingested=await ingest(event,deps);assert.equal(ingested.messages,1);assert.equal((await ingest(event,deps)).duplicate,true);
 const opt=(await f.db.query("SELECT phone FROM account_whatsapp_opt_outs WHERE phone='+919456789012'")).rows[0];assert.ok(opt,'new opt-out uses canonical +91 format');
 assert.equal((await f.db.query("SELECT phone FROM whatsapp_opt_outs WHERE phone='+919456789012'")).rows.length,1,'shared Booking opt-out respects same destination');
 const future=await draft(f);assert.equal((await audience(ADMIN,future.id,{refresh:true},f.opts)).count,3);
 await drain({...f.opts,max:20});const done=await get(ADMIN,c.id,f.opts);assert.equal(done.stats.sent,3);assert.equal(done.stats.skipped,1);assert.equal(f.deliveries.some(x=>x.phone==='+919456789012'),false);
});

test('parallel campaign drains honor the sender campaign lock and bounded batch without duplicate delivery',async t=>{
 const f=await fixture(t);let c=await approved(f);c=await start(ADMIN,c.id,consent(c),f.opts);
 const results=await Promise.all([drain({...f.opts,max:2}),drain({...f.opts,max:2})]);assert.equal(results.reduce((sum,r)=>sum+r.processed,0),2);assert.equal(f.calls.send,2);
 await drain({...f.opts,max:2});assert.equal(f.calls.send,4);assert.equal(new Set(f.deliveries.map(x=>x.phone)).size,4);assert.equal(f.calls.upload,2,'concurrent worker did not re-upload the PDF');
});

test('a local acceptance-write failure retries persistence only, retaining provider acceptance for inbox recovery',async t=>{
 const f=await fixture(t);let c=await approved(f);c=await start(ADMIN,c.id,consent(c),f.opts);
 const real=f.db.query;let failOnce=true;
 f.db.query=async(sql,args)=>{if(failOnce&&sql.startsWith('UPDATE account_whatsapp_campaign_recipients SET status=CASE')&&sql.includes('sent_at=COALESCE')){failOnce=false;throw new Error('Transient database write timeout');}return real(sql,args);};
 await drain({...f.opts,max:1});assert.equal(f.calls.send,1);let row=(await real('SELECT * FROM account_whatsapp_campaign_recipients ORDER BY id LIMIT 1')).rows[0];assert.equal(row.status,'SENT');assert.equal(row.provider_message_id,'provider-1');assert.match(row.error,/inbox sync pending/);
 c=await get(ADMIN,c.id,f.opts);await pause(ADMIN,c.id,{revision:c.revision},f.opts);await drain(f.opts);assert.equal(f.calls.send,1);row=(await real('SELECT * FROM account_whatsapp_campaign_recipients ORDER BY id LIMIT 1')).rows[0];assert.equal(row.error,null);assert.equal(f.calls.record,1);
});

test('campaign history search applies to title/body within organization and retains cursor pagination',async t=>{
 const f=await fixture(t);const first=await draft(f);const second=await create(ADMIN,{title:'Another event',body:'Join our annual gathering.'},f.opts);
 assert.deepEqual((await list(ADMIN,{q:'OFFICE'},f.opts)).items.map(x=>x.id),[first.id]);
 assert.deepEqual((await list(ADMIN,{search:'annual'},f.opts)).items.map(x=>x.id),[second.id]);
 assert.equal((await list(ADMIN,{q:'%'},f.opts)).items.length,0,'wildcards are literal search text');
 const recent=await list(ADMIN,{limit:1},f.opts);assert.equal(recent.items[0].id,second.id);assert.ok(recent.next_cursor);assert.equal((await list(ADMIN,{cursor:recent.next_cursor,limit:1},f.opts)).items[0].id,first.id);
 assert.equal((await list({...ADMIN,organization_id:2},{q:'Office'},f.opts)).items.length,0);assert.equal(f.calls.create,0);assert.equal(f.calls.send,0);
});
