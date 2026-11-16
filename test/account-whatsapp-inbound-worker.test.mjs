import test from 'node:test';
import assert from 'node:assert/strict';
import {assertAccountWhatsAppInboundQueueUrl,processAccountWhatsAppInboundQueueMessage,pollAccountWhatsAppInboundQueue,startAccountWhatsAppInboundWorker,stopAccountWhatsAppInboundWorker} from '../src/workers/accountWhatsAppInboundWorker.js';

const queueUrl='https://sqs.ap-south-1.amazonaws.com/123456789012/account-whatsapp-inbound';
const config={topics:['arn:aws:sns:ap-south-1:123456789012:whatsapp-events'],senderId:'phone-number-id-test',organizationId:1};
class ReceiveMessageCommand{constructor(input){this.input=input;}}
class DeleteMessageCommand{constructor(input){this.input=input;}}
const commands={ReceiveMessageCommand,DeleteMessageCommand};
const message={Body:'{"Type":"Notification","Message":"signed SNS body"}',ReceiptHandle:'receipt-1'};

test('private ingress queue URL pins AWS account, region, host and protocol before any credential use',()=>{
 assert.equal(assertAccountWhatsAppInboundQueueUrl(queueUrl,{region:'ap-south-1',topics:config.topics}),queueUrl);
 for(const url of [queueUrl.replace('https:','http:'),queueUrl.replace('123456789012','999999999999'),queueUrl.replace('ap-south-1','us-east-1'),queueUrl.replace('amazonaws.com','amazonaws.com.evil.example'),queueUrl+'?endpoint=http://localhost',queueUrl.replace('https://','https://secret@'),'https://127.0.0.1/private']){
  assert.throws(()=>assertAccountWhatsAppInboundQueueUrl(url,{region:'ap-south-1',topics:config.topics}));
 }
});

test('notification is deleted only after the signed-envelope handler committed successfully',async()=>{
 const trace=[];
 const client={send:async command=>{trace.push('delete');assert.ok(command instanceof DeleteMessageCommand);assert.equal(command.input.QueueUrl,queueUrl);assert.equal(command.input.ReceiptHandle,'receipt-1');return {};}};
 const result=await processAccountWhatsAppInboundQueueMessage(message,{client,queueUrl,commands,config,region:'ap-south-1',handleEnvelope:async(body,opts)=>{trace.push('commit');assert.equal(body,message.Body);assert.deepEqual(opts.config,config);return {messages:1};}});
 assert.deepEqual(trace,['commit','delete']);assert.equal(result.deleted,true);
});

test('verification or database failure retains notification and no DeleteMessage is called',async()=>{
 let deletes=0;
 const client={send:async()=>{deletes++;}};
 await assert.rejects(()=>processAccountWhatsAppInboundQueueMessage(message,{client,queueUrl,commands,config,region:'ap-south-1',handleEnvelope:async()=>{throw Error('bad signature');}}),/bad signature/);
 assert.equal(deletes,0);
});

test('a committed duplicate can be safely retried after delete failure without reprocessing customer data',async()=>{
 let commits=0,calls=0;
 const client={send:async()=>{if(++calls===1)throw Error('delete timeout');}};
 const options={client,queueUrl,commands,config,region:'ap-south-1',handleEnvelope:async()=>{commits++;return {duplicate:commits>1};}};
 await assert.rejects(()=>processAccountWhatsAppInboundQueueMessage(message,options),/delete timeout/);
 const result=await processAccountWhatsAppInboundQueueMessage(message,options);
 assert.equal(result.result.duplicate,true);assert.equal(result.deleted,true);
});

test('poll uses one bounded long-poll batch and leaves failed entries for DLQ redrive',async()=>{
 const deleted=[],errors=[];
 const client={send:async command=>{
  if(command instanceof ReceiveMessageCommand){assert.equal(command.input.MaxNumberOfMessages,5);assert.equal(command.input.WaitTimeSeconds,20);assert.equal(command.input.VisibilityTimeout,60);return {Messages:[message,{Body:'bad',ReceiptHandle:'bad-receipt'},{...message,ReceiptHandle:'duplicate'}]};}
  deleted.push(command.input.ReceiptHandle);return {};
 }};
 const result=await pollAccountWhatsAppInboundQueue({client,queueUrl,commands,config,region:'ap-south-1',handleEnvelope:async body=>{if(body==='bad')throw Error('invalid SNS');return {duplicate:false};},onMessageError:error=>errors.push(error.message)});
 assert.deepEqual(result,{received:3,committed:2,failed:1});assert.deepEqual(deleted,['receipt-1','duplicate']);assert.deepEqual(errors,['invalid SNS']);
});

test('stopping the worker promptly aborts the long poll and destroys its client',async()=>{
 let started;const receiving=new Promise(resolve=>{started=resolve;});let destroyed=0,receives=0;
 const client={destroy(){destroyed++;},send(command,options){
  assert.ok(command instanceof ReceiveMessageCommand);receives++;started();
  return new Promise((resolve,reject)=>{options.abortSignal.addEventListener('abort',()=>reject(Object.assign(Error('aborted'),{name:'AbortError'})),{once:true});});
 }};
 const runtime=startAccountWhatsAppInboundWorker({client,queueUrl,commands,config,region:'ap-south-1'});
 await receiving;stopAccountWhatsAppInboundWorker();await runtime.promise;
 assert.equal(receives,1);assert.ok(destroyed>=1);assert.equal(runtime.controller.signal.aborted,true);
});

test('a stop after commit deliberately leaves the notification unacknowledged for a deduplicated retry',async()=>{
 const controller=new AbortController();let deletes=0;
 const result=await processAccountWhatsAppInboundQueueMessage(message,{client:{send:async()=>{deletes++;}},queueUrl,commands,config,region:'ap-south-1',signal:controller.signal,handleEnvelope:async()=>{controller.abort();return {messages:1};}});
 assert.equal(result.committed,true);assert.equal(result.deleted,false);assert.equal(deletes,0);
});
