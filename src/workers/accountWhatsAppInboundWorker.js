import {accountWhatsAppError as fail} from '../services/accountWhatsApp.spec.js';
import {accountWhatsAppInboundConfig,handleAccountWhatsAppSnsEnvelope} from '../services/accountWhatsAppInbound.service.js';

const regionDefault=()=>process.env.WHATSAPP_AWS_REGION||process.env.AWS_REGION||'ap-south-1';
export function assertAccountWhatsAppInboundQueueUrl(value,{region=regionDefault(),topics=accountWhatsAppInboundConfig().topics}={}) {
 let url;try{url=new URL(value);}catch{throw fail('The inbound SQS queue URL is invalid',409);}
 const china=region.startsWith('cn-');const host=`sqs.${region}.amazonaws.com${china?'.cn':''}`;
 const path=/^\/(\d{12})\/([A-Za-z0-9_-]{1,80}(?:\.fifo)?)$/.exec(url.pathname);
 if(url.protocol!=='https:'||url.hostname!==host||url.port||url.username||url.password||url.search||url.hash||!path)throw fail('The inbound SQS queue must use the configured AWS region and endpoint',409);
 const allowed=topics.some(topic=>new RegExp(`^arn:(?:aws|aws-cn|aws-us-gov):sns:${region}:${path[1]}:`).test(topic));
 if(!allowed)throw fail('The inbound queue account and region must match an allowed SNS topic',409);
 return url.toString();
}
const defaultCommands=async()=>import('@aws-sdk/client-sqs');

/** A failed verification/commit leaves the message for the queue's redrive policy. */
export async function processAccountWhatsAppInboundQueueMessage(message,{client,queueUrl,commands,config=accountWhatsAppInboundConfig(),region=regionDefault(),handleEnvelope=handleAccountWhatsAppSnsEnvelope,signal,...deps}={}) {
 const safeUrl=assertAccountWhatsAppInboundQueueUrl(queueUrl,{region,topics:config.topics});
 if(!message?.ReceiptHandle||typeof message.Body!=='string'||Buffer.byteLength(message.Body)>1024*1024)throw fail('Invalid inbound SQS message');
 const sdk=commands||await defaultCommands();
 const result=await handleEnvelope(message.Body,{...deps,config});
 if(signal?.aborted)return {committed:true,deleted:false,result};
 await client.send(new sdk.DeleteMessageCommand({QueueUrl:safeUrl,ReceiptHandle:message.ReceiptHandle}),signal?{abortSignal:signal}:undefined);
 return {committed:true,deleted:true,result};
}
export async function pollAccountWhatsAppInboundQueue({client,queueUrl,commands,config=accountWhatsAppInboundConfig(),region=regionDefault(),signal,...deps}={}) {
 const safeUrl=assertAccountWhatsAppInboundQueueUrl(queueUrl,{region,topics:config.topics});
 const sdk=commands||await defaultCommands();
 const output=await client.send(new sdk.ReceiveMessageCommand({QueueUrl:safeUrl,MaxNumberOfMessages:5,WaitTimeSeconds:20,VisibilityTimeout:60}),signal?{abortSignal:signal}:undefined);
 const result={received:output.Messages?.length||0,committed:0,failed:0};
 // A batch is deliberately small and sequential. Source timestamps handle
 // out-of-order delivery; no receive loop opens one task per customer.
 for(const message of output.Messages||[]){
  if(signal?.aborted)break;
  try{await processAccountWhatsAppInboundQueueMessage(message,{client,queueUrl:safeUrl,commands:sdk,config,region,signal,...deps});result.committed++;}
  catch(error){if(signal?.aborted)break;result.failed++;deps.onMessageError?.(error);}
 }
 return result;
}

let running;
const delay=(ms,signal)=>new Promise(resolve=>{
 if(signal.aborted){resolve();return;}
 const done=()=>{clearTimeout(timer);signal.removeEventListener('abort',done);resolve();};
 const timer=setTimeout(done,ms);timer.unref?.();signal.addEventListener('abort',done,{once:true});
});
export function startAccountWhatsAppInboundWorker(options={}) {
 if(running)return running;
 const queueUrl=options.queueUrl||process.env.WHATSAPP_INBOX_QUEUE_URL;
 if(!queueUrl||process.env.NODE_TEST_CONTEXT&&!options.client)return null;
 const config=options.config||accountWhatsAppInboundConfig(),region=options.region||regionDefault();
 if(!config.senderId||!config.topics?.length||!Number.isSafeInteger(config.organizationId)||config.organizationId<=0)throw fail('Configure the inbound sender, organization and SNS topic before starting the inbox worker',409);
 assertAccountWhatsAppInboundQueueUrl(queueUrl,{region,topics:config.topics});
 const controller=new AbortController();const runtime={controller,client:options.client||null,promise:null};running=runtime;
 runtime.promise=(async()=>{
  const sdk=options.commands||await defaultCommands();
  if(!runtime.client)runtime.client=new sdk.SQSClient({region,maxAttempts:2,requestHandler:{connectionTimeout:5000,requestTimeout:25000,throwOnRequestTimeout:true},
   ...(process.env.WHATSAPP_AWS_ACCESS_KEY_ID?{credentials:{accessKeyId:process.env.WHATSAPP_AWS_ACCESS_KEY_ID,secretAccessKey:process.env.WHATSAPP_AWS_SECRET_ACCESS_KEY,...(process.env.WHATSAPP_AWS_SESSION_TOKEN?{sessionToken:process.env.WHATSAPP_AWS_SESSION_TOKEN}:{})}}:{})});
  while(!controller.signal.aborted){
   try{
    const result=await pollAccountWhatsAppInboundQueue({...options,client:runtime.client,commands:sdk,queueUrl,config,region,signal:controller.signal});
    if(result.failed)await delay(1000,controller.signal);
   }catch(error){
    if(controller.signal.aborted)break;
    (options.onError||(()=>console.error('[whatsapp-inbox] Could not process the inbound queue; retrying')))(error);
    await delay(5000,controller.signal);
   }
  }
 })().catch(error=>{if(!controller.signal.aborted)(options.onError||(()=>console.error('[whatsapp-inbox] Inbound worker stopped')))(error);})
 .finally(()=>{runtime.client?.destroy?.();if(running===runtime)running=null;});
 return runtime;
}
export function stopAccountWhatsAppInboundWorker() {
 const runtime=running;if(!runtime)return;
 running=null;runtime.controller.abort();runtime.client?.destroy?.();
}
