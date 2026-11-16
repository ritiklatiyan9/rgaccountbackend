import { createHash } from 'node:crypto';
import pool from '../config/db.js';
import { accountWhatsAppError as fail } from './accountWhatsApp.spec.js';

const nowDate = () => new Date();
const senderDefault = () => process.env.WHATSAPP_PHONE_NUMBER_ID || '';
export const whatsappStatusRank = status => ({UNKNOWN:0,SENDING:1,SENT:2,FAILED:3,DELIVERED:4,READ:5,RECEIVED:1,DELETED:6}[status] ?? 0);
export function normalizeAccountWhatsAppInboxPhone(value) {
 let phone=String(value || '').replace(/\D/g,'').replace(/^00/,'');
 if (/^[6-9]\d{9}$/.test(phone)) phone=`91${phone}`;
 return /^[1-9]\d{7,14}$/.test(phone) && new Set(phone).size>1 ? `+${phone}` : '';
}
export function assertAccountWhatsAppInboxAdmin(user) {
 if (!user || !['admin','super_admin'].includes(user.role)) throw fail('Administrator access is required',403);
 const id=Number(user.organization_id);
 if (!Number.isSafeInteger(id)||id<=0) throw fail('An organization is required',403);
 return id;
}
function positiveId(value,label='Conversation') {
 const text=String(value || '');
 if (!/^[1-9]\d{0,17}$/.test(text)) throw fail(`${label} is invalid`);
 return text;
}
const limitOf=(value,defaultValue=30,max=100)=>Math.min(max,Math.max(1,Number.parseInt(value,10)||defaultValue));
function decodeCursor(value) {
 if (!value) return null;
 try {
  const [time,id]=JSON.parse(Buffer.from(String(value),'base64url').toString('utf8'));
  const date=new Date(time);
  if (!Number.isFinite(date.getTime())) throw Error();
  return [date.toISOString(),positiveId(id)];
 } catch {throw fail('The inbox cursor is invalid');}
}
const encodeCursor=row=>Buffer.from(JSON.stringify([new Date(row.last_message_at).toISOString(),String(row.id)])).toString('base64url');
const messageView=row=>({...row,id:String(row.id),conversation_id:String(row.conversation_id),text:row.text||'',document_url:null,media_available:false});
function readiness(senderId=senderDefault()) {
 const organizationId=Number(process.env.WHATSAPP_INBOX_ORGANIZATION_ID);
 const topic=process.env.WHATSAPP_SNS_TOPIC_ARN || process.env.WHATSAPP_SNS_TOPIC_ARNS;
 return {sender_configured:Boolean(senderId),inbound_configured:Boolean(senderId && Number.isSafeInteger(organizationId) && organizationId>0 && topic),connected:false,last_event_at:null,
  ready:Boolean(senderId && Number.isSafeInteger(organizationId) && organizationId>0 && topic),
  reason:!senderId?'Configure the WhatsApp sender to use the inbox':!topic||!organizationId?'Connect the AWS message and event destination to receive replies':null};
}
export function accountWhatsAppInboxReadiness() { return readiness(); }
export async function getAccountWhatsAppInboxReadiness(user,{db=pool,senderId=senderDefault()}={}) {
 const organizationId=assertAccountWhatsAppInboxAdmin(user),connection=readiness(senderId);
 const {rows:[schema]}=await db.query("SELECT to_regclass('public.account_whatsapp_inbound_events') AS events");
 if(!schema?.events)return {...connection,ready:false,schema_ready:false,reason:'Install the WhatsApp inbox database update to use conversations'};
 const {rows:[last]}=await db.query('SELECT received_at FROM account_whatsapp_inbound_events WHERE organization_id=$1 AND sender_id=$2 ORDER BY received_at DESC LIMIT 1',[organizationId,senderId]);
 return {...connection,schema_ready:true,connected:Boolean(last?.received_at),last_event_at:last?.received_at||null,reason:last?.received_at?null:connection.reason||'Waiting for verified AWS message events'};
}

async function conversationFor(user,id,db,senderId=senderDefault(),lock=false) {
 const organizationId=assertAccountWhatsAppInboxAdmin(user);
 if (!senderId) throw fail('Configure the WhatsApp sender to use the inbox',409);
 const {rows:[row]}=await db.query(`SELECT * FROM account_whatsapp_conversations WHERE id=$1 AND organization_id=$2 AND sender_id=$3${lock?' FOR UPDATE':''}`,[positiveId(id),organizationId,senderId]);
 if (!row) throw fail('Conversation not found',404);
 return row;
}
export async function listAccountWhatsAppInbox(user,query={}, {db=pool,senderId=senderDefault()}={}) {
 const organizationId=assertAccountWhatsAppInboxAdmin(user);
 if (!senderId) return {items:[],next_cursor:null,unread_count:0,connection:readiness(senderId)};
 const limit=limitOf(query.limit),cursor=decodeCursor(query.cursor);
 const search=String(query.search||'').trim().slice(0,100);
 const args=[organizationId,senderId];let filter='organization_id=$1 AND sender_id=$2';
 if (search) {args.push(`%${search.replace(/[\\%_]/g,'\\$&')}%`);filter+=` AND (display_name ILIKE $${args.length} ESCAPE '\\' OR phone ILIKE $${args.length} ESCAPE '\\')`;}
 if (query.unread===true || query.unread==='true') filter+=' AND unread_count>0';
 if (cursor) {args.push(...cursor);filter+=` AND (last_message_at,id)<($${args.length-1}::timestamptz,$${args.length}::bigint)`;}
 args.push(limit+1);
 // One round trip and one pool checkout. Parallel page/count reads otherwise
 // open a second remote TLS connection when the pool has one warm connection.
 // The aggregate always returns a row, including an empty/filtered-out page.
 const {rows:[summary]}=await db.query(`WITH page AS (
  SELECT id,display_name AS name,phone,last_message,last_message_at,last_inbound_at,unread_count
   FROM account_whatsapp_conversations WHERE ${filter} ORDER BY last_message_at DESC,id DESC LIMIT $${args.length}
 ) SELECT
  COALESCE((SELECT jsonb_agg(to_jsonb(p)||jsonb_build_object('id',p.id::text) ORDER BY p.last_message_at DESC,p.id DESC) FROM page p),'[]'::jsonb) AS items,
  COALESCE((SELECT SUM(unread_count) FROM account_whatsapp_conversations WHERE organization_id=$1 AND sender_id=$2 AND unread_count>0),0)::int AS unread_count,
  (SELECT received_at FROM account_whatsapp_inbound_events WHERE organization_id=$1 AND sender_id=$2 ORDER BY received_at DESC LIMIT 1) AS last_event_at`,args);
 const rows=summary.items;
 const items=rows.slice(0,limit).map(row=>({...row,id:String(row.id),name:row.name||row.phone}));
 const connection=readiness(senderId),lastEvent=summary.last_event_at;
 return {items,next_cursor:rows.length>limit?encodeCursor(items.at(-1)):null,unread_count:summary.unread_count||0,connection:{...connection,connected:Boolean(lastEvent),last_event_at:lastEvent||null,reason:lastEvent?null:connection.reason||'Waiting for verified AWS message events'}};
}
export async function getAccountWhatsAppInboxMessages(user,id,query={}, {db=pool,senderId=senderDefault(),now=nowDate}={}) {
 const conversation=await conversationFor(user,id,db,senderId);
 const args=[conversation.id];let filter='conversation_id=$1';
 if (query.before_id) {
  const {rows:[before]}=await db.query('SELECT id,created_at FROM account_whatsapp_chat_messages WHERE id=$1 AND conversation_id=$2',[positiveId(query.before_id,'Message'),conversation.id]);
  if (!before) throw fail('Message cursor not found',404);
  args.push(before.created_at,before.id);filter+=' AND (created_at,id)<($2::timestamptz,$3::bigint)';
 }
 const limit=limitOf(query.limit,50);args.push(limit+1);
 const {rows}=await db.query(`SELECT * FROM account_whatsapp_chat_messages WHERE ${filter} ORDER BY created_at DESC,id DESC LIMIT $${args.length}`,args);
 const selected=rows.slice(0,limit);
 const watermark=selected.reduce((highest,row)=>BigInt(row.id)>highest?BigInt(row.id):highest,0n).toString();
 const expires=conversation.last_inbound_at?new Date(new Date(conversation.last_inbound_at).getTime()+86400000):null;
 return {conversation:{...conversation,id:String(conversation.id),name:conversation.display_name||conversation.phone},items:selected.reverse().map(messageView),next_cursor:rows.length>limit?String(selected[0].id):null,read_watermark:watermark,
  reply_window_expires_at:expires?.toISOString()||null,can_reply:Boolean(expires&&expires>now()),reply_blocker:!expires?'A customer message opens the reply window':expires<=now()?'The reply window has closed. Use an approved template to start a new conversation':null};
}
export async function markAccountWhatsAppInboxRead(user,id,{db=pool,senderId=senderDefault(),readThroughId}={}) {
 return transaction(db,async client=>{
  const row=await conversationFor(user,id,client,senderId,true);
  const args=[row.id];let filter='conversation_id=$1';
  if(readThroughId!==undefined&&readThroughId!==null){args.push(String(readThroughId)==='0'?'0':positiveId(readThroughId,'Read watermark'));filter+=' AND id<=$2::bigint';}
  const {rows:[watermark]}=await client.query(`SELECT COALESCE(MAX(id),0) AS id FROM account_whatsapp_chat_messages WHERE ${filter}`,args);
  const through=BigInt(watermark.id)>BigInt(row.last_read_message_id)?String(watermark.id):String(row.last_read_message_id);
  const {rows:[updated]}=await client.query(`UPDATE account_whatsapp_conversations SET last_read_message_id=$2,
   unread_count=(SELECT COUNT(*)::int FROM account_whatsapp_chat_messages WHERE conversation_id=$1 AND direction='INBOUND' AND id>$2::bigint),last_read_at=now(),updated_at=now() WHERE id=$1 RETURNING unread_count`,[row.id,through]);
  return {conversation_id:String(row.id),unread_count:updated.unread_count,read_watermark:through};
 });
}
async function transaction(database,fn) {
 const client=await database.connect();
 try {await client.query('BEGIN');const result=await fn(client);await client.query('COMMIT');return result;}
 catch(error){await client.query('ROLLBACK');throw error;}
 finally{client.release();}
}
async function sendText(to,text,options) { const {sendAccountWhatsAppText}=await import('./accountWhatsApp.service.js');return sendAccountWhatsAppText(to,text,options); }
export async function sendAccountWhatsAppInboxReply(user,id,input={}, {db=pool,senderId=senderDefault(),send=sendText,now=nowDate}={}) {
 assertAccountWhatsAppInboxAdmin(user);
 const text=typeof input.text==='string'?input.text.trim():'';
 if (!text || text.length>4096) throw fail('Write a reply of up to 4,096 characters');
 const key=String(input.idempotency_key||'');
 if (!/^[A-Za-z0-9_-]{12,100}$/.test(key)) throw fail('A valid reply request key is required');
 const hash=createHash('sha256').update(text).digest('hex');
 const reserved=await transaction(db,async client=>{
  const conversation=await conversationFor(user,id,client,senderId,true);
  const {rows:[existing]}=await client.query('SELECT * FROM account_whatsapp_chat_messages WHERE conversation_id=$1 AND idempotency_key=$2',[conversation.id,key]);
  if (existing) {
   if (existing.request_hash!==hash) throw fail('This request key already belongs to a different reply',409);
   return {message:existing,conversation,duplicate:true};
  }
  const expires=conversation.last_inbound_at?new Date(new Date(conversation.last_inbound_at).getTime()+86400000):null;
  if (!expires || expires<=now()) throw fail('The 24-hour reply window is closed. Use an approved template to start a new conversation',409);
  const {rows:[context]}=await client.query("SELECT provider_message_id FROM account_whatsapp_chat_messages WHERE conversation_id=$1 AND direction='INBOUND' ORDER BY created_at DESC,id DESC LIMIT 1",[conversation.id]);
  const {rows:[message]}=await client.query(`INSERT INTO account_whatsapp_chat_messages(conversation_id,organization_id,sender_id,direction,type,text,status,idempotency_key,request_hash,actor_id,context_provider_message_id,created_at)
   VALUES($1,$2,$3,'OUTBOUND','TEXT',$4,'SENDING',$5,$6,$7,$8,$9) RETURNING *`,[conversation.id,conversation.organization_id,senderId,text,key,hash,user.id,context?.provider_message_id||null,now()]);
  return {message,conversation,duplicate:false};
 });
 if (reserved.duplicate) return {message:messageView(reserved.message),conversation_id:String(id),duplicate:true};
 let providerId;
 try {
  providerId=await send(reserved.conversation.phone,text,{contextMessageId:reserved.message.context_provider_message_id,ref:`account-reply:${reserved.message.id}`});
  if (typeof providerId!=='string'||!providerId) throw Error('The provider did not return a message ID');
 } catch(error) {
  const status=error.$metadata?.httpStatusCode>=400&&error.$metadata?.httpStatusCode<500?'FAILED':'UNKNOWN';
  const {rows:[message]}=await db.query('UPDATE account_whatsapp_chat_messages SET status=$2,error=$3,updated_at=now() WHERE id=$1 RETURNING *',[reserved.message.id,status,String(error.message||'The reply outcome could not be confirmed').slice(0,1000)]);
  return {message:messageView(message),conversation_id:String(id),duplicate:false,needs_review:status==='UNKNOWN'};
 }
 const message=await transaction(db,async client=>{
  const {rows:[row]}=await client.query(`UPDATE account_whatsapp_chat_messages SET provider_message_id=$2,status=CASE WHEN status IN ('DELIVERED','READ','FAILED','DELETED') THEN status ELSE 'SENT' END,updated_at=now() WHERE id=$1 RETURNING *`,[reserved.message.id,providerId]);
  await client.query(`UPDATE account_whatsapp_conversations SET last_message=CASE WHEN last_message_at<=$3 THEN $2 ELSE last_message END,
   last_message_at=GREATEST(last_message_at,$3),updated_at=now() WHERE id=$1`,[reserved.conversation.id,text,row.created_at]);
  return row;
 });
 return {message:messageView(message),conversation_id:String(id),duplicate:false};
}

export async function recordAccountWhatsAppCampaignOutbound(input,{db=pool}={}) {
 const organizationId=Number(input.organization_id),senderId=input.sender_id||senderDefault(),phone=normalizeAccountWhatsAppInboxPhone(input.phone);
 if (!Number.isSafeInteger(organizationId)||organizationId<=0||!senderId||!phone) throw fail('Valid campaign sender, organization and phone are required');
 const providerId=String(input.provider_message_id||'');
 if (!providerId) throw fail('The provider message ID is required');
 const sentAt=input.sent_at?new Date(input.sent_at):new Date();
 if(!Number.isFinite(sentAt.getTime()))throw fail('A valid outbound send time is required');
 return transaction(db,async client=>{
  const correlation=input.recipient_id?`account-campaign:${input.recipient_id}`:providerId;
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`whatsapp:${senderId}:${correlation}`]);
  const {rows:[conversation]}=await client.query(`INSERT INTO account_whatsapp_conversations(organization_id,sender_id,phone,display_name,last_message_at)
   VALUES($1,$2,$3,$4,$5) ON CONFLICT(organization_id,sender_id,phone) DO UPDATE SET display_name=COALESCE(account_whatsapp_conversations.display_name,EXCLUDED.display_name) RETURNING *`,[organizationId,senderId,phone,input.full_name||null,sentAt]);
  const {rows:[pending]}=await client.query('SELECT * FROM account_whatsapp_message_statuses WHERE sender_id=$1 AND organization_id=$2 AND (provider_message_id=$3 OR callback_data=$4) ORDER BY status_rank DESC LIMIT 1',[senderId,organizationId,providerId,`account-campaign:${input.recipient_id}`]);
  const status=pending&&pending.status_rank>whatsappStatusRank(input.status||'SENT')?pending.status:input.status||'SENT';
  const body=status==='DELETED'?'Message deleted':String(input.body||'').slice(0,4096);
  const {rows:[message]}=await client.query(`INSERT INTO account_whatsapp_chat_messages(conversation_id,organization_id,sender_id,direction,type,text,status,provider_message_id,provider_external_id,campaign_id,campaign_recipient_id,document_filename,delivered_at,read_at,created_at)
   VALUES($1,$2,$3,'OUTBOUND',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
   ON CONFLICT(sender_id,provider_message_id) DO UPDATE SET status=CASE WHEN account_whatsapp_chat_messages.status IN ('DELIVERED','READ','FAILED','DELETED') THEN account_whatsapp_chat_messages.status ELSE EXCLUDED.status END RETURNING *`,
   [conversation.id,organizationId,senderId,input.document?'DOCUMENT':'TEXT',body,status,providerId,pending?.provider_message_id!==providerId?pending?.provider_message_id||null:null,input.campaign_id||null,input.recipient_id||null,status==='DELETED'?null:input.document?.filename||null,['DELIVERED','READ'].includes(status)?pending?.event_at||null:null,status==='READ'?pending?.event_at||null:null,sentAt]);
  await client.query(`UPDATE account_whatsapp_conversations SET last_message=CASE WHEN last_message_at<=$3 THEN $2 ELSE last_message END,
   last_message_at=GREATEST(last_message_at,$3),updated_at=now() WHERE id=$1`,[conversation.id,message.text,message.created_at]);
  return {conversation_id:String(conversation.id),message_id:String(message.id)};
 });
}

export async function recordAccountWhatsAppOutbound(db,input) {
 return recordAccountWhatsAppCampaignOutbound({organization_id:input.organizationId,sender_id:input.senderId,phone:input.phone,body:input.text,provider_message_id:input.providerMessageId,status:input.status||'SENT',document:input.documentFilename?{filename:input.documentFilename}:null,campaign_id:input.campaignId,recipient_id:input.recipientId,full_name:input.fullName,sent_at:input.sentAt},{db});
}
