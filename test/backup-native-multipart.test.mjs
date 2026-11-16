import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { setImmediate as nextTurn, setTimeout as delay } from 'node:timers/promises';
import { createNativeBackupStorage } from '../src/services/nativeBackupStorage.js';

const MIB=1024*1024;
const config={prefix:'tests',bucket:'private-test',region:'ap-south-1',partSize:5*MIB,uploadConcurrency:2,maxArchiveBytes:128*MIB};
const key='tests/fixture/attempt-1-00000000-0000-0000-0000-000000000000/database.dump';
function source(bytes=17*MIB) {
  const chunk=Buffer.alloc(65536,0x41);
  return Readable.from((async function*(){for(let offset=0;offset<bytes;offset+=chunk.length)yield chunk.subarray(0,Math.min(chunk.length,bytes-offset));})(),{objectMode:false,highWaterMark:65536});
}
function fake(handler=()=>undefined) {
  const calls=[];
  const client={config:{requestHandler:{},endpoint:async()=>({protocol:'https:',hostname:'fixture.invalid'})},send:async(command,options={})=>{
    calls.push({name:command.constructor.name,part:command.input.PartNumber,signal:options.abortSignal});
    const override=await handler(command,options);
    if(override!==undefined)return override;
    switch(command.constructor.name){
      case 'CreateMultipartUploadCommand':return {UploadId:'fixture-upload'};
      case 'UploadPartCommand':await nextTurn();return {ETag:`"${command.input.PartNumber}"`};
      case 'CompleteMultipartUploadCommand':return {ETag:'"complete"',VersionId:'v1'};
      case 'PutObjectCommand':return {ETag:'"single"',VersionId:'v1'};
      case 'AbortMultipartUploadCommand':return {};
      default:throw new Error(command.constructor.name);
    }
  }};
  return {client,calls,storage:createNativeBackupStorage(config,{client})};
}
const waitForAbort=signal=>new Promise((resolve,reject)=>{if(signal.aborted)reject(signal.reason);else signal.addEventListener('abort',()=>reject(signal.reason),{once:true});});

test('actual AWS Upload splits unknown-length streams into bounded parts and finalizes once',async()=>{
  let active=0,peak=0,bytes=0,largest=0;
  const {storage,calls}=fake(async command=>{
    if(command.constructor.name==='UploadPartCommand'){
      active++;peak=Math.max(peak,active);largest=Math.max(largest,command.input.Body.length);
      try{await nextTurn();bytes+=command.input.Body.length;return {ETag:`"${command.input.PartNumber}"`};}finally{active--;}
    }
  });
  const result=await storage.upload(key,source());
  assert.equal(result.bytes,17*MIB);assert.equal(bytes,result.bytes);assert.ok(peak<=2);assert.ok(largest<=5*MIB);
  assert.equal(calls.filter(call=>call.name==='CompleteMultipartUploadCommand').length,1);
  assert.equal(calls.filter(call=>call.name==='AbortMultipartUploadCommand').length,0);
});

test('actual AWS Upload part failure aborts another stalled HTTP command promptly and cleans multipart state', {timeout:2000},async()=>{
  let stalledSignal;
  const {storage,calls}=fake(async(command,{abortSignal})=>{
    if(command.constructor.name==='UploadPartCommand'){
      if(command.input.PartNumber===1){await delay(20);throw Object.assign(new Error('network interruption'),{code:'ECONNRESET'});}
      stalledSignal=abortSignal;await waitForAbort(abortSignal);
    }
  });
  await assert.rejects(storage.upload(key,source()),/network interruption|abort/i);
  assert.equal(stalledSignal?.aborted,true);
  assert.ok(calls.some(call=>call.name==='AbortMultipartUploadCommand'));
  assert.ok(!calls.some(call=>call.name==='CompleteMultipartUploadCommand'));
});

test('actual AWS Upload cancellation passes AbortSignal to pending part requests and cleans with independent signal', {timeout:2000},async()=>{
  const controller=new AbortController();let started;
  const firstPart=new Promise(resolve=>{started=resolve;});
  const {storage,calls}=fake(async(command,{abortSignal})=>{
    if(command.constructor.name==='UploadPartCommand'){started();await waitForAbort(abortSignal);}
  });
  const task=storage.upload(key,source(),{signal:controller.signal});
  const rejection=assert.rejects(task,/abort|cancel/i);
  await firstPart;controller.abort();await rejection;
  assert.ok(calls.filter(call=>call.name==='UploadPartCommand').every(call=>call.signal.aborted));
  const cleanup=calls.find(call=>call.name==='AbortMultipartUploadCommand');
  assert.ok(cleanup);assert.equal(cleanup.signal.aborted,false);
});

test('actual AWS Upload rejects incomplete multipart completion metadata and aborts its upload',async()=>{
  const {storage,calls}=fake(command=>command.constructor.name==='CompleteMultipartUploadCommand'?{}:undefined);
  await assert.rejects(storage.upload(key,source()),/complete|ETag|metadata|response/i);
  assert.ok(calls.some(call=>call.name==='AbortMultipartUploadCommand'));
});

test('actual AWS Upload cleanup permission errors remain visible on the rejected attempt',async()=>{
  const {storage,calls}=fake(command=>{
    if(command.constructor.name==='UploadPartCommand')throw Object.assign(new Error('part denied'),{code:'EACCES'});
    if(command.constructor.name==='AbortMultipartUploadCommand')throw Object.assign(new Error('cleanup denied'),{code:'EACCES'});
  });
  await assert.rejects(storage.upload(key,source()),error=>error.cleanupFailed===true);
  assert.ok(calls.some(call=>call.name==='AbortMultipartUploadCommand'));
});
