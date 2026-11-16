import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,sign} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {up} from '../src/migrations/252_account_whatsapp_inbox.js';
import {listAccountWhatsAppInbox,getAccountWhatsAppInboxMessages,markAccountWhatsAppInboxRead,sendAccountWhatsAppInboxReply,recordAccountWhatsAppCampaignOutbound,getAccountWhatsAppInboxReadiness} from '../src/services/accountWhatsAppInbox.service.js';
import {ingestAccountWhatsAppEvent,verifyAccountWhatsAppSnsEnvelope,accountWhatsAppSnsSigningString,handleAccountWhatsAppSnsEnvelope} from '../src/services/accountWhatsAppInbound.service.js';

const user={id:1,role:'admin',organization_id:1};
const senderId='phone-number-id-test';
const date=new Date('2026-11-18T08:00:00Z');
const seconds=offset=>Math.floor((date.getTime()+offset)/1000).toString();
const now=()=>date;
const topic='arn:aws:sns:ap-south-1:123456789012:whatsapp-events';
const config={topics:[topic],senderId,organizationId:1};
const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048});
const publicPem=publicKey.export({type:'spki',format:'pem'});
const signed=(Type='Notification',changes={})=>{
 const envelope={Type,MessageId:'sns-event-1',Message:'{}',Timestamp:date.toISOString(),TopicArn:topic,SignatureVersion:'2',SigningCertURL:'https://sns.ap-south-1.amazonaws.com/SimpleNotificationService-abcdef0123456789.pem',...changes};
 envelope.Signature=sign('RSA-SHA256',Buffer.from(accountWhatsAppSnsSigningString(envelope)),privateKey).toString('base64');return envelope;
};
const event=(value={})=>({aws_account_id:'123456789012',context:{MetaPhoneNumberIds:[{arn:`arn:aws:social-messaging:ap-south-1:123456789012:phone-number-id/${senderId}`,metaPhoneNumberId:'meta-phone-1'}]},whatsAppWebhookEntry:JSON.stringify({id:'waba-1',changes:[{field:'messages',value:{messaging_product:'whatsapp',metadata:{phone_number_id:'meta-phone-1'},...value}}]})});
const inbound=(text='Hello',id='wamid.inbound1',offset=0)=>event({contacts:[{wa_id:'919876543210',profile:{name:'Asha'}}],messages:[{id,from:'919876543210',timestamp:seconds(offset),type:'text',text:{body:text}}]});
async function fixture(t,{campaigns=false,booking=false}={}){
 const pg=new PGlite();
 let tail=Promise.resolve();
 const db={query:(sql,args=[])=>args.length?pg.query(sql,args):pg.exec(sql).then(rows=>rows.at(-1)),connect:async()=>{
  const before=tail;let release;tail=new Promise(resolve=>{release=resolve;});await before;return {query:db.query,release};
 }};
 t.after(()=>pg.close());await up(db);
 if(campaigns)await db.query(`CREATE TABLE account_whatsapp_campaigns(id BIGINT PRIMARY KEY,organization_id INTEGER,sender_id TEXT);
 CREATE TABLE account_whatsapp_campaign_recipients(id BIGINT PRIMARY KEY,campaign_id BIGINT,organization_id INTEGER,phone TEXT,provider_message_id TEXT,status TEXT,error TEXT,sent_at TIMESTAMPTZ,delivered_at TIMESTAMPTZ,read_at TIMESTAMPTZ,replied_at TIMESTAMPTZ,updated_at TIMESTAMPTZ);
 INSERT INTO account_whatsapp_campaigns VALUES(10,1,'${senderId}');
 INSERT INTO account_whatsapp_campaign_recipients(id,campaign_id,organization_id,phone,provider_message_id,status,sent_at) VALUES(100,10,1,'+919876543210','aws-outbound-1','SENT','2026-11-18T07:00:00Z');`);
 if(booking)await db.query('CREATE TABLE whatsapp_opt_outs(phone varchar(16) PRIMARY KEY,reason text,created_by integer,created_at timestamptz DEFAULT now())');
 return {pg,db,options:{db,senderId,now},ingest:(payload,key='event1')=>ingestAccountWhatsAppEvent(payload,{db,organizationId:1,senderId,now,eventKey:key,accountId:'123456789012',region:'ap-south-1'})};
}

test('SNS requires a valid signature, exact configured topic, and regional Amazon certificate URL',async()=>{
 let certificateReads=0;const options={config,now,getCertificate:async()=>{certificateReads++;return publicPem;}};
 const envelope=signed();assert.equal((await verifyAccountWhatsAppSnsEnvelope(envelope,options)).MessageId,'sns-event-1');
 await assert.rejects(()=>verifyAccountWhatsAppSnsEnvelope({...envelope,Message:'tampered'},options),/signature/);
 await assert.rejects(()=>verifyAccountWhatsAppSnsEnvelope({...envelope,TopicArn:'arn:aws:sns:ap-south-1:123456789012:other'},options),/topic/);
 for(const SigningCertURL of ['http://sns.ap-south-1.amazonaws.com/SimpleNotificationService-abcdef0123456789.pem','https://sns.ap-south-1.amazonaws.com.evil.example/SimpleNotificationService-abcdef0123456789.pem','https://127.0.0.1/private.pem','https://sns.ap-south-1.amazonaws.com/SimpleNotificationService-abcdef0123456789.pem?redirect=http://localhost']){
  await assert.rejects(()=>verifyAccountWhatsAppSnsEnvelope({...envelope,SigningCertURL},options),/Untrusted/);
 }
 assert.equal(certificateReads,2);
 await assert.rejects(()=>verifyAccountWhatsAppSnsEnvelope(envelope,{...options,config:{...config,topics:[]}}),/not configured/);
});

test('SNS subscription confirmation cannot fetch arbitrary URLs and only follows a signed exact topic/token',async()=>{
 const token='secret-subscription-token';
 const confirmationUrl=`https://sns.ap-south-1.amazonaws.com/?Action=ConfirmSubscription&TopicArn=${encodeURIComponent(topic)}&Token=${token}`;
 const envelope=signed('SubscriptionConfirmation',{SubscribeURL:confirmationUrl,Token:token});let requests=0;
 const options={config,now,getCertificate:async()=>publicPem,fetch:async(url,request)=>{requests++;assert.equal(String(url),confirmationUrl);assert.equal(request.redirect,'error');return {ok:true};}};
 assert.deepEqual(await handleAccountWhatsAppSnsEnvelope(envelope,options),{subscription_confirmed:true});
 await assert.rejects(()=>handleAccountWhatsAppSnsEnvelope(signed('SubscriptionConfirmation',{SubscribeURL:'https://evil.example/?Action=ConfirmSubscription',Token:token}),options),/Untrusted/);
 await assert.rejects(()=>handleAccountWhatsAppSnsEnvelope({...envelope,Signature:'broken'},options),/signature/);
 assert.equal(requests,1);
});

test('migration is idempotent and importing services does not activate subscriptions or sends',async t=>{
 const {db}=await fixture(t);assert.equal(await up(db),false);
 assert.equal((await db.query('SELECT COUNT(*)::int AS n FROM account_whatsapp_chat_messages')).rows[0].n,0);
});

test('inbound events and provider messages deduplicate independently and bind the configured sender',async t=>{
 const {db,ingest,options}=await fixture(t);
 assert.equal((await ingest(inbound())).messages,1);
 assert.equal((await ingest(inbound())).duplicate,true);
 assert.equal((await ingest(inbound(),'event2')).messages,0);
 const list=await listAccountWhatsAppInbox(user,{},options);
 assert.equal(list.items.length,1);assert.equal(list.unread_count,1);assert.equal(list.items[0].name,'Asha');assert.equal(list.connection.connected,true);
 const foreign=inbound();foreign.context.MetaPhoneNumberIds[0].arn=foreign.context.MetaPhoneNumberIds[0].arn.replace(senderId,'phone-number-id-other');
 await assert.rejects(()=>ingest(foreign,'foreign'),/different WhatsApp sender/);
 const foreignRegion=inbound();foreignRegion.context.MetaPhoneNumberIds[0].arn=foreignRegion.context.MetaPhoneNumberIds[0].arn.replace('ap-south-1','us-east-1');
 await assert.rejects(()=>ingest(foreignRegion,'foreign-region'),/different WhatsApp sender/);
 assert.equal((await db.query('SELECT COUNT(*)::int AS n FROM account_whatsapp_inbound_events')).rows[0].n,2);
});

test('both AWS event context spellings and prefixed/unprefixed ARN resources bind the same sender',async t=>{
 const {ingest,options}=await fixture(t);
 const older=inbound('Older AWS format');
 older.context.MetaPhoneNumberIds[0].arn=older.context.MetaPhoneNumberIds[0].arn.replace(`/phone-number-id/${senderId}`,'/phone-number-id/test');
 await ingest(older,'old-context');
 const newer=inbound('New AWS format','wamid.snake',1000);
 newer.context={meta_phone_number_ids:newer.context.MetaPhoneNumberIds.map(row=>({arn:row.arn,meta_phone_number_id:row.metaPhoneNumberId}))};
 await ingest(newer,'new-context');
 const list=await listAccountWhatsAppInbox(user,{},options);assert.equal(list.unread_count,2);assert.equal(list.items[0].last_message,'New AWS format');
});

test('organization isolation, bounded keyset pagination and read markers do not send messages',async t=>{
 const {db,ingest,options}=await fixture(t);await ingest(inbound());
 await db.query(`INSERT INTO account_whatsapp_conversations(organization_id,sender_id,phone,display_name,last_message_at,unread_count) VALUES(1,$1,'+919876543211','Bela','2026-11-18T08:00:01Z',2),(2,$1,'+919876543212','Other organization','2026-11-18T08:00:02Z',9)`,[senderId]);
 const one=await listAccountWhatsAppInbox(user,{limit:1},options);assert.equal(one.items.length,1);assert.equal(one.items[0].name,'Bela');assert.equal(one.unread_count,3);assert.ok(one.next_cursor);
 const two=await listAccountWhatsAppInbox(user,{limit:1,cursor:one.next_cursor},options);assert.equal(two.items[0].name,'Asha');assert.equal(two.next_cursor,null);
 const search=await listAccountWhatsAppInbox(user,{search:'Ash'},options);assert.equal(search.items.length,1);
 const id=two.items[0].id;
 await assert.rejects(()=>getAccountWhatsAppInboxMessages({...user,organization_id:2},id,{},options),/not found/);
 await assert.rejects(()=>getAccountWhatsAppInboxMessages({...user,role:'sub_admin'},id,{},options),/Administrator/);
 const history=await getAccountWhatsAppInboxMessages(user,id,{},options);assert.equal(history.items[0].text,'Hello');assert.equal(history.can_reply,true);
 await markAccountWhatsAppInboxRead(user,id,options);assert.equal((await listAccountWhatsAppInbox(user,{},options)).unread_count,2);
 assert.equal((await db.query("SELECT COUNT(*)::int AS n FROM account_whatsapp_chat_messages WHERE direction='OUTBOUND'")).rows[0].n,0);
});

test('inbox page, unread total and event readiness share one query for empty and populated keyset pages',async t=>{
 const {db,ingest,options}=await fixture(t);let queries=0;
 const readDb={query:(...args)=>{queries++;return db.query(...args);},connect:()=>{throw Error('A list read must not open a second connection');}};
 const read=async query=>{const before=queries;const result=await listAccountWhatsAppInbox(user,query,{...options,db:readDb});assert.equal(queries-before,1);return result;};
 const empty=await read({limit:1});assert.deepEqual(empty.items,[]);assert.equal(empty.next_cursor,null);assert.equal(empty.unread_count,0);assert.equal(empty.connection.connected,false);
 await ingest(inbound());
 await db.query(`INSERT INTO account_whatsapp_conversations(id,organization_id,sender_id,phone,display_name,last_message_at,unread_count) VALUES
  (9007199254740992,1,$1,'+919876543211','Second','2026-11-18T09:00:00Z',2),
  (9007199254740993,1,$1,'+919876543212','First','2026-11-18T09:00:00Z',3),
  (9007199254740994,2,$1,'+919876543213','Other organization','2026-11-18T10:00:00Z',99)`,[senderId]);
 const first=await read({limit:1});assert.equal(first.items[0].id,'9007199254740993');assert.equal(first.unread_count,6);assert.equal(first.connection.connected,true);assert.ok(first.connection.last_event_at);
 const second=await read({limit:1,cursor:first.next_cursor});assert.equal(second.items[0].id,'9007199254740992');
 const third=await read({limit:1,cursor:second.next_cursor});assert.equal(third.items[0].name,'Asha');assert.equal(third.next_cursor,null);
 const filtered=await read({search:'No matching contact',unread:true});assert.deepEqual(filtered.items,[]);assert.equal(filtered.next_cursor,null);assert.equal(filtered.unread_count,6);assert.equal(filtered.connection.connected,true);
});

test('out-of-order old inbound events neither move the conversation backward nor extend the reply window',async t=>{
 const {ingest,options}=await fixture(t);await ingest(inbound('Latest'));await ingest(inbound('Older','wamid.old',-86400000*3),'old-event');
 const list=await listAccountWhatsAppInbox(user,{},options);assert.equal(list.items[0].last_message,'Latest');
 const history=await getAccountWhatsAppInboxMessages(user,list.items[0].id,{},options);
 assert.equal(history.reply_window_expires_at,'2026-11-19T08:00:00.000Z');assert.deepEqual(history.items.map(m=>m.text),['Older','Latest']);
 const page=await getAccountWhatsAppInboxMessages(user,list.items[0].id,{limit:1},options);assert.equal(page.items[0].text,'Latest');
 const previous=await getAccountWhatsAppInboxMessages(user,list.items[0].id,{before_id:page.next_cursor,limit:1},options);assert.equal(previous.items[0].text,'Older');
});

test('mark-read watermark preserves an arrival concurrent with acknowledging the displayed messages',async t=>{
 const {ingest,options}=await fixture(t);await ingest(inbound());
 const {items:[conversation]}=await listAccountWhatsAppInbox(user,{},options);
 const shown=await getAccountWhatsAppInboxMessages(user,conversation.id,{},options);
 await Promise.all([
  markAccountWhatsAppInboxRead(user,conversation.id,{...options,readThroughId:shown.read_watermark}),
  ingest(inbound('A new unseen message','wamid.new',1000),'new-event')
 ]);
 assert.equal((await listAccountWhatsAppInbox(user,{},options)).unread_count,1);
 const latest=await getAccountWhatsAppInboxMessages(user,conversation.id,{},options);
 await markAccountWhatsAppInboxRead(user,conversation.id,{...options,readThroughId:latest.read_watermark});
 assert.equal((await listAccountWhatsAppInbox(user,{},options)).unread_count,0);
});

test('manual replies enforce the actual inbound window, reserve once, and never resend ambiguous attempts',async t=>{
 const {db,ingest,options}=await fixture(t);await ingest(inbound());const {items:[conversation]}=await listAccountWhatsAppInbox(user,{},options);let calls=0;
 const send=async(phone,text,context)=>{calls++;assert.equal(phone,'+919876543210');assert.equal(context.contextMessageId,'wamid.inbound1');assert.match(context.ref,/^account-reply:/);return 'aws-reply-1';};
 const input={text:'Thank you for your reply',idempotency_key:'reply-request-1234'};
 const first=await sendAccountWhatsAppInboxReply(user,conversation.id,input,{...options,send});assert.equal(first.message.status,'SENT');
 const repeated=await sendAccountWhatsAppInboxReply(user,conversation.id,input,{...options,send});assert.equal(repeated.duplicate,true);assert.equal(calls,1);
 await assert.rejects(()=>sendAccountWhatsAppInboxReply(user,conversation.id,{...input,text:'Changed reply'},{...options,send}),/different reply/);
 await assert.rejects(()=>sendAccountWhatsAppInboxReply(user,conversation.id,{...input,idempotency_key:'outside-window-123'},{...options,send,now:()=>new Date('2026-11-20T08:00:00Z')}),/window is closed/);
 const unknownInput={text:'Second reply',idempotency_key:'unknown-request-123'};
 const ambiguous=await sendAccountWhatsAppInboxReply(user,conversation.id,unknownInput,{...options,send:async()=>{calls++;throw Error('network timeout');}});
 assert.equal(ambiguous.message.status,'UNKNOWN');assert.equal(ambiguous.needs_review,true);
 await sendAccountWhatsAppInboxReply(user,conversation.id,unknownInput,{...options,send});assert.equal(calls,2);
 assert.equal((await db.query("SELECT COUNT(*)::int AS n FROM account_whatsapp_chat_messages WHERE direction='OUTBOUND'")).rows[0].n,2);
});

test('concurrent duplicate reply requests share the same reserved message and only one transport call',async t=>{
 const {ingest,options}=await fixture(t);await ingest(inbound());const {items:[conversation]}=await listAccountWhatsAppInbox(user,{},options);
 let begin;const started=new Promise(resolve=>{begin=resolve;});let finish;const transport=new Promise(resolve=>{finish=resolve;});let calls=0;
 const input={text:'Hello Asha',idempotency_key:'concurrent-reply-1234'};
 const first=sendAccountWhatsAppInboxReply(user,conversation.id,input,{...options,send:async()=>{calls++;begin();return transport;}});
 await started;
 const duplicate=await sendAccountWhatsAppInboxReply(user,conversation.id,input,{...options,send:async()=>{calls++;return 'incorrect';}});
 assert.equal(duplicate.duplicate,true);assert.equal(duplicate.message.status,'SENDING');finish('aws-once');await first;assert.equal(calls,1);
});

test('delivery/read receipts are monotonic and campaign callbacks correlate AWS and Meta identifiers',async t=>{
 const {db,ingest}=await fixture(t,{campaigns:true});
 const locks=[];const query=db.query;db.query=(sql,args=[])=>{if(sql.includes('pg_advisory_xact_lock'))locks.push(args[0]);return query(sql,args);};
 const status=(state,offset=0)=>event({statuses:[{id:'wamid.outbound1',status:state,timestamp:seconds(offset),recipient_id:'919876543210',biz_opaque_callback_data:'account-campaign:100'}]});
 await ingest(status('read'),'read-first');
 await recordAccountWhatsAppCampaignOutbound({organization_id:1,sender_id:senderId,phone:'919876543210',campaign_id:10,recipient_id:100,body:'Invitation',provider_message_id:'aws-outbound-1',status:'SENT',document:{filename:'INVITATION.pdf'}},{db});
 assert.equal(locks[0],locks[1],'receipt and projection must serialize using callback identity even when AWS and Meta IDs differ');
 let message=(await db.query("SELECT * FROM account_whatsapp_chat_messages WHERE direction='OUTBOUND'")).rows[0];assert.equal(message.status,'READ');assert.equal(message.provider_external_id,'wamid.outbound1');assert.equal(message.document_filename,'INVITATION.pdf');
 await ingest(status('delivered',-1000),'late-delivered');await ingest(status('failed',-2000),'late-failed');
 message=(await db.query('SELECT * FROM account_whatsapp_chat_messages WHERE id=$1',[message.id])).rows[0];assert.equal(message.status,'READ');
 const recipient=(await db.query('SELECT * FROM account_whatsapp_campaign_recipients WHERE id=100')).rows[0];assert.equal(recipient.status,'READ');assert.ok(recipient.read_at);
 const reply=inbound('We will attend');const body=JSON.parse(reply.whatsAppWebhookEntry);body.changes[0].value.messages[0].context={id:'wamid.outbound1'};reply.whatsAppWebhookEntry=body;
 await ingest(reply,'campaign-reply');assert.ok((await db.query('SELECT replied_at FROM account_whatsapp_campaign_recipients WHERE id=100')).rows[0].replied_at);
});

test('outbound projection recovery preserves its original time and never displaces a newer customer reply',async t=>{
 const {db,ingest,options}=await fixture(t,{campaigns:true});
 const outgoing={organization_id:1,sender_id:senderId,phone:'+919876543210',campaign_id:10,recipient_id:100,body:'Invitation',provider_message_id:'aws-outbound-1',status:'SENT',sent_at:'2026-11-18T07:00:00Z',document:{filename:'INVITATION.pdf'}};
 await recordAccountWhatsAppCampaignOutbound(outgoing,{db});await ingest(inbound('I will attend'));
 await recordAccountWhatsAppCampaignOutbound({...outgoing,sent_at:'2026-11-18T09:00:00Z'},{db});
 const {items:[conversation]}=await listAccountWhatsAppInbox(user,{},options);assert.equal(conversation.last_message,'I will attend');
 const messages=await getAccountWhatsAppInboxMessages(user,conversation.id,{},options);
 assert.deepEqual(messages.items.map(m=>m.text),['Invitation','I will attend']);
 assert.equal(new Date(messages.items[0].created_at).toISOString(),'2026-11-18T07:00:00.000Z');
});

test('quoted replies correlate despite second precision and can precede their outbound status notification',async t=>{
 const {db,ingest}=await fixture(t,{campaigns:true});
 await db.query("UPDATE account_whatsapp_campaign_recipients SET sent_at='2026-11-18T08:00:00.750Z' WHERE id=100");
 await recordAccountWhatsAppCampaignOutbound({organization_id:1,sender_id:senderId,phone:'+919876543210',campaign_id:10,recipient_id:100,body:'Invitation',provider_message_id:'aws-outbound-1',status:'SENT',sent_at:'2026-11-18T08:00:00.750Z'},{db});
 const reply=inbound('Attending');const value=JSON.parse(reply.whatsAppWebhookEntry);value.changes[0].value.messages[0].context={id:'wamid.actual-outbound'};reply.whatsAppWebhookEntry=value;
 await ingest(reply,'reply-before-status');
 assert.equal((await db.query('SELECT replied_at FROM account_whatsapp_campaign_recipients WHERE id=100')).rows[0].replied_at,null);
 await ingest(event({statuses:[{id:'wamid.actual-outbound',status:'delivered',timestamp:seconds(0),biz_opaque_callback_data:'account-campaign:100'}]}),'status-after-reply');
 assert.ok((await db.query('SELECT replied_at FROM account_whatsapp_campaign_recipients WHERE id=100')).rows[0].replied_at);
});

test('STOP is idempotent and suppresses marketing in both accountancy and the shared Booking sender',async t=>{
 const {db,ingest}=await fixture(t,{booking:true});await ingest(inbound('STOP'));
 assert.equal((await db.query('SELECT active FROM account_whatsapp_opt_outs')).rows[0].active,true);
 assert.equal((await db.query('SELECT phone FROM whatsapp_opt_outs')).rows[0].phone,'+919876543210');
 await ingest(inbound('START','wamid.start'),'start');assert.equal((await db.query('SELECT active FROM account_whatsapp_opt_outs')).rows[0].active,false);
 assert.equal((await db.query('SELECT COUNT(*)::int AS n FROM whatsapp_opt_outs')).rows[0].n,0);
 await db.query("INSERT INTO whatsapp_opt_outs(phone,reason) VALUES('+919876543210','Operator opt-out')");
 await ingest(inbound('START','wamid.start2'),'start2');assert.equal((await db.query('SELECT reason FROM whatsapp_opt_outs')).rows[0].reason,'Operator opt-out');
 await ingest(inbound('STOP','wamid.newstop',2000),'new-stop');
 await ingest(inbound('START','wamid.delayed-start',-1000),'delayed-start');
 assert.equal((await db.query('SELECT active FROM account_whatsapp_opt_outs')).rows[0].active,true);
 assert.equal((await db.query('SELECT reason FROM whatsapp_opt_outs')).rows[0].reason,'Operator opt-out');
});

test('document and button replies remain readable without exposing unauthenticated media URLs',async t=>{
 const {ingest,options}=await fixture(t);await ingest(event({messages:[{id:'wamid.doc',from:'919876543210',timestamp:seconds(0),type:'document',document:{filename:'RSVP.pdf',id:'private-media',mime_type:'application/pdf'}}]}));
 await ingest(event({messages:[{id:'wamid.button',from:'919876543210',timestamp:seconds(1000),type:'interactive',interactive:{button_reply:{title:'Attending',id:'yes'}}}]}),'button');
 const list=await listAccountWhatsAppInbox(user,{},options);const messages=await getAccountWhatsAppInboxMessages(user,list.items[0].id,{},options);
 assert.equal(messages.items[0].document_filename,'RSVP.pdf');assert.equal(messages.items[0].document_url,null);assert.equal(messages.items[1].text,'Attending');
});
