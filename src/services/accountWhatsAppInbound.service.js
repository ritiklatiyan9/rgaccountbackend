import { createHash, createPublicKey, verify, X509Certificate } from 'node:crypto';
import pool from '../config/db.js';
import { accountWhatsAppError as fail } from './accountWhatsApp.spec.js';
import { normalizeAccountWhatsAppInboxPhone, whatsappStatusRank } from './accountWhatsAppInbox.service.js';

const MAX_ENVELOPE=1024*1024;
const certificates=new Map();
const clean=(value,max=4096)=>String(value??'').replace(/\u0000/g,'').slice(0,max);
const configuredTopics=()=>String(process.env.WHATSAPP_SNS_TOPIC_ARNS||process.env.WHATSAPP_SNS_TOPIC_ARN||'').split(',').map(v=>v.trim()).filter(Boolean);
export const accountWhatsAppInboundConfig=()=>({topics:configuredTopics(),senderId:process.env.WHATSAPP_PHONE_NUMBER_ID||'',organizationId:Number(process.env.WHATSAPP_INBOX_ORGANIZATION_ID),accountId:process.env.WHATSAPP_INBOX_AWS_ACCOUNT_ID||null,region:process.env.WHATSAPP_AWS_REGION||process.env.AWS_REGION||'ap-south-1'});
function topicInfo(topic) {
 const match=/^arn:(aws|aws-cn|aws-us-gov):sns:([a-z0-9-]+):(\d{12}):[A-Za-z0-9_.-]{1,256}$/.exec(topic);
 if (!match) throw fail('Unrecognized SNS topic',403);
 return {partition:match[1],region:match[2],accountId:match[3],host:`sns.${match[2]}.amazonaws.com${match[1]==='aws-cn'?'.cn':''}`};
}
export function assertAccountWhatsAppSnsUrl(value,topic,{certificate=false,token}={}) {
 const info=topicInfo(topic);let url;
 try {url=new URL(value);}catch {throw fail('Invalid SNS verification URL',403);}
 if (url.protocol!=='https:'||url.hostname!==info.host||url.port||url.username||url.password||url.hash) throw fail('Untrusted SNS verification URL',403);
 if (certificate) {
  if (url.search||!/^\/SimpleNotificationService-[A-Za-z0-9_-]{8,120}\.pem$/.test(url.pathname)) throw fail('Untrusted SNS signing certificate',403);
 } else {
  const allowed=new Set(['Action','TopicArn','Token','Version']);
  if (url.pathname!=='/'||[...url.searchParams.keys()].some(k=>!allowed.has(k))||url.searchParams.get('Action')!=='ConfirmSubscription'||url.searchParams.get('TopicArn')!==topic||url.searchParams.get('Token')!==token) throw fail('Untrusted SNS confirmation URL',403);
 }
 return url;
}
export function accountWhatsAppSnsSigningString(envelope) {
 const keys=envelope.Type==='Notification'?['Message','MessageId',...(envelope.Subject!==undefined?['Subject']:[]),'Timestamp','TopicArn','Type']:
  ['Message','MessageId','SubscribeURL','Timestamp','Token','TopicArn','Type'];
 return keys.map(key=>{
  if(typeof envelope[key]!=='string'||!envelope[key]) throw fail(`Missing SNS ${key}`,403);
  return `${key}\n${envelope[key]}\n`;
 }).join('');
}
async function fetchSigningCertificate(url,{fetch:fetcher=globalThis.fetch,now=()=>new Date()}={}) {
 const cached=certificates.get(String(url));
 if(cached&&cached.expires>Date.now()) return cached.pem;
 const response=await fetcher(url,{redirect:'error',signal:AbortSignal.timeout(5000)});
 if(!response.ok) throw fail('SNS signing certificate could not be retrieved',503);
 if(Number(response.headers.get('content-length'))>65536) throw fail('Invalid SNS signing certificate',403);
 const chunks=[];let length=0;
 for await(const chunk of response.body){length+=chunk.length;if(length>65536)throw fail('Invalid SNS signing certificate',403);chunks.push(Buffer.from(chunk));}
 const pem=Buffer.concat(chunks).toString('utf8');let certificate;
 try {certificate=new X509Certificate(pem);}catch{throw fail('Invalid SNS signing certificate',403);}
 const current=now();
 if(current<new Date(certificate.validFrom)||current>new Date(certificate.validTo)||certificate.publicKey.asymmetricKeyType!=='rsa') throw fail('Expired or invalid SNS signing certificate',403);
 if(certificates.size>=32)certificates.delete(certificates.keys().next().value);
 certificates.set(String(url),{pem,expires:Math.min(Date.now()+3600000,new Date(certificate.validTo).getTime())});
 return pem;
}
export async function verifyAccountWhatsAppSnsEnvelope(input,{config=accountWhatsAppInboundConfig(),getCertificate=fetchSigningCertificate,fetch:fetcher=globalThis.fetch,now=()=>new Date()}={}) {
 let envelope=input;
 if (Buffer.isBuffer(input))envelope=input.toString('utf8');
 if(typeof envelope==='string'){
  if(Buffer.byteLength(envelope)>MAX_ENVELOPE)throw fail('SNS notification is too large',413);
  try{envelope=JSON.parse(envelope);}catch{throw fail('Invalid SNS notification',400);}
 }
 if(!envelope||typeof envelope!=='object'||Array.isArray(envelope))throw fail('Invalid SNS notification',400);
 if(Buffer.byteLength(JSON.stringify(envelope))>MAX_ENVELOPE)throw fail('SNS notification is too large',413);
 if(!config.topics?.length||!config.senderId||!Number.isSafeInteger(config.organizationId)||config.organizationId<=0)throw fail('WhatsApp inbound event routing is not configured',503);
 if(!config.topics.includes(envelope.TopicArn))throw fail('Unexpected SNS topic',403);
 if(!['Notification','SubscriptionConfirmation','UnsubscribeConfirmation'].includes(envelope.Type))throw fail('Unsupported SNS message',403);
 if(!['1','2'].includes(String(envelope.SignatureVersion))||typeof envelope.Signature!=='string'||envelope.Signature.length>4096)throw fail('Invalid SNS signature',403);
 const timestamp=new Date(envelope.Timestamp);
 if(!Number.isFinite(timestamp.getTime())||timestamp.getTime()>now().getTime()+300000)throw fail('Invalid SNS timestamp',403);
 if(String(envelope.MessageId||'').length>200)throw fail('Invalid SNS message ID',403);
 const url=assertAccountWhatsAppSnsUrl(envelope.SigningCertURL,envelope.TopicArn,{certificate:true});
 const pem=await getCertificate(url,{fetch:fetcher,now});
 let valid=false;
 try{valid=verify(String(envelope.SignatureVersion)==='2'?'RSA-SHA256':'RSA-SHA1',Buffer.from(accountWhatsAppSnsSigningString(envelope)),createPublicKey(pem),Buffer.from(envelope.Signature,'base64'));}catch{}
 if(!valid)throw fail('Invalid SNS signature',403);
 return envelope;
}
function senderEntry(event,senderId,accountId,region) {
 const values=event?.context?.MetaPhoneNumberIds||event?.context?.meta_phone_number_ids;
 if(!Array.isArray(values))throw fail('The event has no authenticated WhatsApp sender context',403);
 const entry=values.find(item=>{
  const arn=String(item.arn||'');const match=/^arn:(?:aws|aws-cn|aws-us-gov):social-messaging:([a-z0-9-]+):(\d{12}):phone-number-id\/([^/]+)$/.exec(arn);
  // AWS's API ID is phone-number-id-<uuid>; older published event ARNs use
  // phone-number-id/<uuid>, while newer events include the prefix in the ARN.
  const resource=value=>String(value).split('/').at(-1).replace(/^phone-number-id-/,'');
  return match&&resource(match[3])===resource(senderId)&&(!accountId||match[2]===accountId)&&(!region||match[1]===region);
 });
 if(!entry)throw fail('The event belongs to a different WhatsApp sender',403);
 if(accountId&&event.aws_account_id&&String(event.aws_account_id)!==accountId)throw fail('Unexpected WhatsApp AWS account',403);
 return String(entry.metaPhoneNumberId||entry.meta_phone_number_id||'');
}
function eventDate(value,now) {
 const seconds=Number(value);
 if(!Number.isFinite(seconds)||seconds<=0)return null;
 const date=new Date(seconds*1000);
 if(!Number.isFinite(date.getTime())||date.getTime()>now.getTime()+300000)return null;
 return date>now?now:date;
}
function inboundContent(message) {
 const kind=String(message.type||'unknown').toLowerCase();
 if(kind==='text')return {type:'TEXT',text:clean(message.text?.body)};
 if(kind==='button')return {type:'BUTTON',text:clean(message.button?.text||message.button?.payload)};
 if(kind==='interactive')return {type:'BUTTON',text:clean(message.interactive?.button_reply?.title||message.interactive?.list_reply?.title||message.interactive?.nfm_reply?.body||'Interactive reply')};
 if(kind==='reaction')return {type:'REACTION',text:clean(message.reaction?.emoji||'Reaction')};
 if(['document','image','video','audio','sticker'].includes(kind)){
  const media=message[kind]||{};
  return {type:kind.toUpperCase(),text:clean(media.caption||(kind==='document'?media.filename:null)||`${kind[0].toUpperCase()+kind.slice(1)} received`),filename:clean(media.filename,255)||null,mediaId:clean(media.id,512)||null,mime:clean(media.mime_type,120)||null};
 }
 return {type:'UNKNOWN',text:'Unsupported WhatsApp message'};
}
const statusFrom=value=>({accepted:'SENT',sent:'SENT',delivered:'DELIVERED',read:'READ',failed:'FAILED',deleted:'DELETED','WhatsApp Message Handover Succeeded':'SENT','WhatsApp Message Handover Failed':'FAILED','Message retries exhausted, dropping message.':'FAILED'}[String(value)]||null);
async function schemaReady(client) {
 const {rows:[row]}=await client.query("SELECT to_regclass('public.account_whatsapp_campaign_recipients') AS recipients,to_regclass('public.account_whatsapp_campaigns') AS campaigns,to_regclass('public.whatsapp_opt_outs') AS booking_opt_outs");
 return {campaigns:Boolean(row?.recipients&&row?.campaigns),bookingOptOuts:Boolean(row?.booking_opt_outs)};
}
async function applyReceipt(client,status,{organizationId,senderId,current,campaigns}) {
 const providerId=clean(status.id,512),state=statusFrom(status.status),at=eventDate(status.timestamp,current);
 if(!providerId||!state||!at)return false;
 const callback=clean(status.biz_opaque_callback_data,200)||null;
 const error=clean(status.errors?.map(e=>e.message||e.title||e.code).join('; '),1000)||null;
 const rank=whatsappStatusRank(state);
 const replyId=/^account-reply:([1-9]\d{0,17})$/.exec(callback||'')?.[1]||null;
 const recipientId=/^account-campaign:([1-9]\d{0,17})$/.exec(callback||'')?.[1]||null;
 const correlation=replyId||recipientId?callback:providerId;
 await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`whatsapp:${senderId}:${correlation}`]);
 await client.query(`INSERT INTO account_whatsapp_message_statuses(sender_id,provider_message_id,organization_id,status,status_rank,event_at,callback_data,error)
  VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(sender_id,provider_message_id) DO UPDATE SET
  status=CASE WHEN EXCLUDED.status_rank>account_whatsapp_message_statuses.status_rank THEN EXCLUDED.status ELSE account_whatsapp_message_statuses.status END,
  status_rank=GREATEST(EXCLUDED.status_rank,account_whatsapp_message_statuses.status_rank),event_at=GREATEST(EXCLUDED.event_at,account_whatsapp_message_statuses.event_at),
  callback_data=COALESCE(EXCLUDED.callback_data,account_whatsapp_message_statuses.callback_data),error=COALESCE(EXCLUDED.error,account_whatsapp_message_statuses.error),updated_at=now()`,[senderId,providerId,organizationId,state,rank,at,callback,error]);
 await client.query(`UPDATE account_whatsapp_chat_messages SET
  status=CASE WHEN (CASE status WHEN 'READ' THEN 5 WHEN 'DELIVERED' THEN 4 WHEN 'FAILED' THEN 3 WHEN 'SENT' THEN 2 WHEN 'SENDING' THEN 1 WHEN 'DELETED' THEN 6 ELSE 0 END)<$4 THEN $3 ELSE status END,
  provider_external_id=COALESCE(provider_external_id,$2),delivered_at=CASE WHEN $3 IN ('DELIVERED','READ') THEN COALESCE(delivered_at,$5) ELSE delivered_at END,
  read_at=CASE WHEN $3='READ' THEN COALESCE(read_at,$5) ELSE read_at END,
  text=CASE WHEN $3='DELETED' THEN 'Message deleted' ELSE text END,media_id=CASE WHEN $3='DELETED' THEN NULL ELSE media_id END,
  error=COALESCE($6,error),updated_at=now()
  WHERE sender_id=$1 AND organization_id=$7 AND (provider_message_id=$2 OR provider_external_id=$2 OR ($8::bigint IS NOT NULL AND id=$8) OR ($9::bigint IS NOT NULL AND campaign_recipient_id=$9))`,[senderId,providerId,state,rank,at,error,organizationId,replyId,recipientId]);
 if(campaigns&&state!=='DELETED')await client.query(`UPDATE account_whatsapp_campaign_recipients r SET
  status=CASE WHEN (CASE r.status WHEN 'READ' THEN 5 WHEN 'DELIVERED' THEN 4 WHEN 'FAILED' THEN 3 WHEN 'SENT' THEN 2 WHEN 'SENDING' THEN 1 ELSE 0 END)<$4 THEN $3 ELSE r.status END,
  delivered_at=CASE WHEN $3 IN ('DELIVERED','READ') THEN COALESCE(r.delivered_at,$5) ELSE r.delivered_at END,
  read_at=CASE WHEN $3='READ' THEN COALESCE(r.read_at,$5) ELSE r.read_at END,
  replied_at=COALESCE(r.replied_at,(SELECT MIN(i.created_at) FROM account_whatsapp_chat_messages i JOIN account_whatsapp_conversations v ON v.id=i.conversation_id
   WHERE i.organization_id=$7 AND i.sender_id=$1 AND i.direction='INBOUND' AND i.context_provider_message_id=$2 AND v.phone=r.phone)),error=COALESCE($6,r.error),updated_at=now()
  FROM account_whatsapp_campaigns c WHERE r.campaign_id=c.id AND c.sender_id=$1 AND r.organization_id=$7 AND (r.provider_message_id=$2 OR ($8::bigint IS NOT NULL AND r.id=$8))`,[senderId,providerId,state,rank,at,error,organizationId,recipientId]);
 return true;
}
async function applyInbound(client,message,value,{organizationId,senderId,current,campaigns,bookingOptOuts}) {
 const providerId=clean(message.id,512),phone=normalizeAccountWhatsAppInboxPhone(message.from),at=eventDate(message.timestamp,current);
 if(!providerId||!phone||!at)return false;
 const content=inboundContent(message);
 const name=clean(value.contacts?.find(c=>String(c.wa_id)===String(message.from))?.profile?.name,200)||null;
 const {rows:[conversation]}=await client.query(`INSERT INTO account_whatsapp_conversations(organization_id,sender_id,phone,display_name,last_message_at)
  VALUES($1,$2,$3,$4,$5) ON CONFLICT(organization_id,sender_id,phone) DO UPDATE SET display_name=COALESCE(EXCLUDED.display_name,account_whatsapp_conversations.display_name) RETURNING *`,[organizationId,senderId,phone,name,at]);
 const contextId=clean(message.context?.id,512)||null;
 const {rows}=await client.query(`INSERT INTO account_whatsapp_chat_messages(conversation_id,organization_id,sender_id,direction,type,text,status,provider_message_id,document_filename,media_id,media_mime_type,context_provider_message_id,created_at)
  VALUES($1,$2,$3,'INBOUND',$4,$5,'RECEIVED',$6,$7,$8,$9,$10,$11) ON CONFLICT(sender_id,provider_message_id) DO NOTHING RETURNING id`,[conversation.id,organizationId,senderId,content.type,content.text,providerId,content.filename||null,content.mediaId||null,content.mime||null,contextId,at]);
 if(!rows.length)return false;
 await client.query(`UPDATE account_whatsapp_conversations SET unread_count=unread_count+1,
  last_message=CASE WHEN last_message_at<=$2 THEN $3 ELSE last_message END,last_message_at=GREATEST(last_message_at,$2),
  last_inbound_at=GREATEST(COALESCE(last_inbound_at,$2),$2),updated_at=now() WHERE id=$1`,[conversation.id,at,content.text]);
 const opt=content.text.trim().toUpperCase();
 if(['STOP','UNSUBSCRIBE','CANCEL','बंद'].includes(opt)||['START','UNSTOP','SUBSCRIBE'].includes(opt)){
  const active=['STOP','UNSUBSCRIBE','CANCEL','बंद'].includes(opt);
  const {rows:changed}=await client.query(`INSERT INTO account_whatsapp_opt_outs(organization_id,sender_id,phone,active,source,last_event_at) VALUES($1,$2,$3,$4,$5,$6)
   ON CONFLICT(organization_id,sender_id,phone) DO UPDATE SET active=EXCLUDED.active,source=EXCLUDED.source,last_event_at=EXCLUDED.last_event_at,updated_at=now()
   WHERE account_whatsapp_opt_outs.last_event_at<=EXCLUDED.last_event_at RETURNING active`,[organizationId,senderId,phone,active,active?'INBOUND_STOP':'INBOUND_START',at]);
  if(bookingOptOuts&&changed.length){
   if(active)await client.query("INSERT INTO whatsapp_opt_outs(phone,reason,created_by) VALUES($1,'INBOUND_STOP:accountancy',NULL) ON CONFLICT(phone) DO NOTHING",[phone]);
   else await client.query("DELETE FROM whatsapp_opt_outs WHERE phone=$1 AND reason='INBOUND_STOP:accountancy'",[phone]);
  }
 }
 if(campaigns){
  // Prefer the quoted invitation. Without a quote, associate only the newest
  // prior campaign message to that number, rather than marking every campaign.
  await client.query(`UPDATE account_whatsapp_campaign_recipients SET replied_at=COALESCE(replied_at,$4),updated_at=now() WHERE id=(
   SELECT r.id FROM account_whatsapp_campaign_recipients r JOIN account_whatsapp_campaigns c ON c.id=r.campaign_id
   LEFT JOIN account_whatsapp_chat_messages m ON m.campaign_recipient_id=r.id
   WHERE r.organization_id=$1 AND c.sender_id=$2 AND r.phone=$3
   AND (($5::text IS NULL AND r.sent_at<=$4::timestamptz+interval '1 second') OR ($5::text IS NOT NULL AND (r.provider_message_id=$5 OR m.provider_message_id=$5 OR m.provider_external_id=$5)))
   ORDER BY r.sent_at DESC,r.id DESC LIMIT 1)`,[organizationId,senderId,phone,at,contextId]);
 }
 return true;
}

/** Internal trusted bridge. Public HTTP must use the signed SNS handler below. */
export async function ingestAccountWhatsAppEvent(event,{db=pool,organizationId,senderId,eventKey,accountId,region=process.env.WHATSAPP_AWS_REGION||process.env.AWS_REGION||'ap-south-1',now=()=>new Date()}={}) {
 if(!Number.isSafeInteger(Number(organizationId))||Number(organizationId)<=0||!senderId||!eventKey)throw fail('A bound sender, organization and event key are required',403);
 const metaPhone=senderEntry(event,senderId,accountId,region);
 if(!metaPhone)throw fail('The event has no Meta phone-number binding',403);
 let webhook=event.whatsAppWebhookEntry;
 if(typeof webhook==='string'){try{webhook=JSON.parse(webhook);}catch{throw fail('Invalid WhatsApp event payload');}}
 const entries=Array.isArray(webhook?.entry)?webhook.entry:Array.isArray(webhook)?webhook:[webhook];
 if(entries.length>100)throw fail('Too many WhatsApp entries');
 let itemCount=0;
 for(const entry of entries){
  if(!Array.isArray(entry?.changes)||entry.changes.length>100)throw fail('Invalid WhatsApp changes');
  for(const change of entry.changes){
   for(const key of ['statuses','messages']){
    const items=change?.value?.[key]||[];
    if(!Array.isArray(items)||items.length>100)throw fail('Too many WhatsApp message events');
    itemCount+=items.length;
   }
  }
 }
 if(itemCount>200)throw fail('Too many WhatsApp message events');
 const client=await db.connect();
 try{
  await client.query('BEGIN');
  const key=createHash('sha256').update(String(eventKey)).digest('hex');
  const receipt=await client.query('INSERT INTO account_whatsapp_inbound_events(event_key,organization_id,sender_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING event_key',[key,organizationId,senderId]);
  if(!receipt.rows.length){await client.query('COMMIT');return {duplicate:true,messages:0,statuses:0};}
  const schemas=await schemaReady(client);const options={organizationId:Number(organizationId),senderId,current:now(),...schemas};
  let messages=0,statuses=0;
  for(const entry of entries){
   for(const change of entry.changes){
    const value=change?.value;
    if(value?.messaging_product!=='whatsapp'||String(value?.metadata?.phone_number_id)!==metaPhone)continue;
    for(const status of (value.statuses||[]))statuses+=Number(await applyReceipt(client,status,options));
    for(const message of (value.messages||[]))messages+=Number(await applyInbound(client,message,value,options));
   }
  }
  await client.query('COMMIT');return {duplicate:false,messages,statuses};
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}

export async function handleAccountWhatsAppSnsEnvelope(input,options={}) {
 const config=options.config||accountWhatsAppInboundConfig();
 const envelope=await verifyAccountWhatsAppSnsEnvelope(input,{...options,config});
 if(envelope.Type==='UnsubscribeConfirmation')return {unsubscribed:true};
 if(envelope.Type==='SubscriptionConfirmation'){
  const url=assertAccountWhatsAppSnsUrl(envelope.SubscribeURL,envelope.TopicArn,{token:envelope.Token});
  const result=await (options.fetch||globalThis.fetch)(url,{redirect:'error',signal:AbortSignal.timeout(5000)});
  if(!result.ok)throw fail('SNS subscription confirmation failed',503);
  await result.body?.cancel?.();
  return {subscription_confirmed:true};
 }
 let event;try{event=JSON.parse(envelope.Message);}catch{throw fail('Invalid WhatsApp event message');}
 const info=topicInfo(envelope.TopicArn);
 return ingestAccountWhatsAppEvent(event,{...options,organizationId:config.organizationId,senderId:config.senderId,accountId:config.accountId||info.accountId,region:config.region||info.region,eventKey:`${envelope.TopicArn}:${envelope.MessageId}`});
}
