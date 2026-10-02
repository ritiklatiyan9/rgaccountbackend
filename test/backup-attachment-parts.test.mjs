import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { ATTACHMENT_PART_FORMAT, attachmentFileId, attachmentPartPreview, createAttachmentPartRestores, decodeBackupPart, exportAttachmentParts, validateAttachmentPart } from '../src/services/backupAttachmentParts.js';
import { encodeArchiveWithMetadata } from '../src/services/backupArchive.js';

const context={backupId:'81a37b3c-9016-4c12-bf7c-d8f5c39a1f19',recordsChecksum:'a'.repeat(64),month:'2026-10'};
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const descriptor={storage:'local',key:'kyc_documents/proof.pdf'};
const CHUNK=65536;
function chunk(bytes,index=0,file=descriptor) {
  const piece=bytes.subarray(index*CHUNK,(index+1)*CHUNK);
  const count=Math.max(1,Math.ceil(bytes.length/CHUNK));
  return {...file,fileId:attachmentFileId(file),fileSize:bytes.length,chunkSize:CHUNK,chunkCount:count,chunkIndex:index,offset:index*CHUNK,data:piece.toString('base64'),sha256:hash(piece),...(index===count-1 ? {fileSha256:hash(bytes)} : {})};
}
const payload=(chunks,partIndex=2)=>({...context,partIndex,chunks});
async function temporary(t) {
  const cwd=await fs.mkdtemp(path.join(os.tmpdir(),'backup-parts-test-'));
  t.after(()=>fs.rm(cwd,{recursive:true,force:true}));return cwd;
}
async function original(cwd,bytes) {
  const directory=path.join(cwd,'uploads','kyc_documents');await fs.mkdir(directory,{recursive:true});
  await fs.writeFile(path.join(directory,'proof.pdf'),bytes);
}

test('large originals export in bounded archives and reconstruct byte for byte from unordered parts',async t=>{
  const before=process.env.BACKUP_MAX_EXPANDED_MB;process.env.BACKUP_MAX_EXPANDED_MB='1';
  t.after(()=>{if(before===undefined) delete process.env.BACKUP_MAX_EXPANDED_MB;else process.env.BACKUP_MAX_EXPANDED_MB=before;});
  const source=await temporary(t),target=await temporary(t);
  const bytes=crypto.randomBytes(2*1024*1024+13);await original(source,bytes);
  const parts=[];
  const exported=await exportAttachmentParts({files:[descriptor]},context,{cwd:source,env:{},publish:async part=>parts.push(part)});
  assert.ok(parts.length>=4);assert.equal(exported.attachmentBytes,bytes.length);
  const manager=createAttachmentPartRestores({cwd:target,env:{}});t.after(()=>manager.close());
  assert.throws(()=>manager.assertComplete(7,context.backupId,context.recordsChecksum,[attachmentFileId(descriptor)]),/all matching/);
  for(const part of parts.slice().reverse()) {
    assert.ok(part.buffer.length<1024*1024);
    const decoded=await decodeBackupPart(part.buffer,{env:{}});
    assert.equal(decoded.format,ATTACHMENT_PART_FORMAT);assert.equal(decoded.checksum,part.checksum);
    const preview=attachmentPartPreview(decoded);assert.ok(preview.chunks.every(item=>!('data' in item)));
    await manager.restore(7,decoded);
  }
  manager.assertComplete(7,context.backupId,context.recordsChecksum,[attachmentFileId(descriptor)]);
  assert.throws(()=>manager.assertComplete(8,context.backupId,context.recordsChecksum,[attachmentFileId(descriptor)]),/all matching/);
  assert.throws(()=>manager.assertComplete(7,context.backupId,'b'.repeat(64),[attachmentFileId(descriptor)]),/all matching/);
  assert.deepEqual(await fs.readFile(path.join(target,'uploads','kyc_documents','proof.pdf')),bytes);
  assert.deepEqual(await fs.readFile(path.join(source,'uploads','kyc_documents','proof.pdf')),bytes); // export is read-only
  assert.equal((await manager.restore(7,await decodeBackupPart(parts[0].buffer,{env:{}}))).created,0);
});

test('stream boundaries, exact full chunks and empty originals carry a correct final whole-file hash',async t=>{
  const cwd=await temporary(t);
  for(const size of [0,CHUNK,CHUNK*2,CHUNK*2+11]) {
    const bytes=crypto.randomBytes(size);await original(cwd,bytes);const parts=[];
    await exportAttachmentParts({files:[descriptor]},context,{cwd,env:{},chunkBytes:CHUNK,publish:async part=>parts.push(part)});
    const decoded=await decodeBackupPart(parts[0].buffer,{env:{}});
    assert.deepEqual(Buffer.concat(decoded.payload.chunks.map(item=>Buffer.from(item.data,'base64'))),bytes);
    assert.equal(decoded.payload.chunks.at(-1).fileSha256,hash(bytes));
  }
});

test('part grouping accounts for long object metadata under small expansion limits',async t=>{
  const before=process.env.BACKUP_MAX_EXPANDED_MB;process.env.BACKUP_MAX_EXPANDED_MB='1';
  t.after(()=>{if(before===undefined) delete process.env.BACKUP_MAX_EXPANDED_MB;else process.env.BACKUP_MAX_EXPANDED_MB=before;});
  const env={AWS_S3_BUCKET_NAME:'backup-test',AWS_REGION:'ap-south-1'};
  const bytes=Buffer.alloc(4096,3);const parts=[];
  const refs={files:Array.from({length:210},(_,i)=>({storage:'s3',bucket:'backup-test',region:'ap-south-1',key:`docs/${'x'.repeat(950)}-${i}`}))};
  await exportAttachmentParts(refs,context,{env,s3Send:async()=>({ContentLength:bytes.length,Body:Readable.from([bytes])}),publish:async part=>parts.push(part)});
  let files=0;
  for(const part of parts) files+=(await decodeBackupPart(part.buffer,{env})).payload.chunks.length;
  assert.equal(files,210);assert.ok(parts.length>=2);
});

test('a stalled storage body times out instead of leaving preparation locked forever',async()=>{
  const env={AWS_S3_BUCKET_NAME:'backup-test',AWS_REGION:'ap-south-1'};
  const refs={files:[{storage:'s3',bucket:'backup-test',region:'ap-south-1',key:'docs/a'}]};
  await assert.rejects(exportAttachmentParts(refs,context,{env,readTimeoutMs:20,s3Send:async()=>({ContentLength:3,Body:new Readable({read(){}})}),publish:()=>assert.fail('stalled original published')}),/ETIMEDOUT/);
});

test('missing chunks remain private; retries reuse originals and different destination contents are preserved',async t=>{
  const cwd=await temporary(t);const bytes=crypto.randomBytes(CHUNK+7);
  const manager=createAttachmentPartRestores({cwd,env:{}});t.after(()=>manager.close());
  await manager.restore(7,{payload:payload([chunk(bytes,0)])});
  await assert.rejects(fs.access(path.join(cwd,'uploads','kyc_documents','proof.pdf')),/ENOENT/);
  const complete=await manager.restore(7,{payload:payload([chunk(bytes,1)],3)});
  assert.equal(complete.created,1);assert.equal(complete.pendingFiles,0);
  assert.equal((await manager.restore(7,{payload:payload([chunk(bytes,1)],3)})).reused,1);
  const other=crypto.randomBytes(CHUNK+7);
  await assert.rejects(manager.restore(7,{payload:payload([chunk(other,0)])}),/conflicts/);
  const another=createAttachmentPartRestores({cwd,env:{}});t.after(()=>another.close());
  await assert.rejects(another.restore(7,{payload:payload([chunk(other,0),chunk(other,1)])}),/different contents/);
  assert.deepEqual(await fs.readFile(path.join(cwd,'uploads','kyc_documents','proof.pdf')),bytes);
});

test('corrupt chunks, forged identities, duplicate chunks, unsafe paths and incorrect reconstructed hashes fail',async t=>{
  const bytes=Buffer.from('fixture');const saved=chunk(bytes);
  for(const change of [{sha256:'0'.repeat(64)},{fileId:'0'.repeat(64)},{offset:1},{chunkSize:1},{fileSize:20},{key:'kyc_documents/../escape'}]) {
    assert.throws(()=>validateAttachmentPart(payload([{...saved,...change}]),{env:{}}));
  }
  assert.throws(()=>validateAttachmentPart(payload([saved,saved]),{env:{}}),/duplicate/);
  const cwd=await temporary(t);const manager=createAttachmentPartRestores({cwd,env:{}});t.after(()=>manager.close());
  await assert.rejects(manager.restore(7,{payload:payload([{...saved,fileSha256:'0'.repeat(64)}])}),/Reassembled original checksum/);
  await assert.rejects(fs.access(path.join(cwd,'uploads')),/ENOENT/);
  const encoded=await encodeArchiveWithMetadata(payload([saved]),{format:ATTACHMENT_PART_FORMAT,validate:validateAttachmentPart});
  const broken=Buffer.from(encoded.buffer);broken[broken.length-4]^=1;
  await assert.rejects(decodeBackupPart(broken));
});

test('S3 streams restore through conditional creation and never overwrite a different object',async t=>{
  const cwd=await temporary(t);const env={AWS_S3_BUCKET_NAME:'backup-test',AWS_REGION:'ap-south-1'};
  const file={storage:'s3',bucket:'backup-test',region:'ap-south-1',key:'docs/proof.pdf'};
  const bytes=crypto.randomBytes(CHUNK*2);const parts=[];
  await exportAttachmentParts({files:[file]},context,{env,chunkBytes:CHUNK,s3Send:async()=>({ContentLength:bytes.length,Body:Readable.from([bytes.subarray(0,13),bytes.subarray(13)])}),publish:async part=>parts.push(part)});
  const objects=new Map();let puts=0;
  const s3Send=async(_file,command)=>{
    if(command.constructor.name==='GetObjectCommand') {
      if(!objects.has(command.input.Key)) throw Object.assign(new Error('missing'),{name:'NoSuchKey'});
      return {Body:Readable.from([objects.get(command.input.Key)])};
    }
    assert.equal(command.input.IfNoneMatch,'*');puts++;
    const chunks=[];for await(const piece of command.input.Body) chunks.push(piece);
    objects.set(command.input.Key,Buffer.concat(chunks));return {};
  };
  const manager=createAttachmentPartRestores({env,cwd,s3Send});t.after(()=>manager.close());
  const decoded=await decodeBackupPart(parts[0].buffer,{env});
  assert.equal((await manager.restore(7,decoded)).created,1);assert.equal(puts,1);
  assert.deepEqual(objects.get(file.key),bytes);
  const again=createAttachmentPartRestores({env,cwd,s3Send});t.after(()=>again.close());
  assert.equal((await again.restore(7,decoded)).reused,1);assert.equal(puts,1);
  objects.set(file.key,Buffer.from('different'));
  const conflict=createAttachmentPartRestores({env,cwd,s3Send});t.after(()=>conflict.close());
  await assert.rejects(conflict.restore(7,decoded),/different contents/);assert.equal(puts,1);
});

test('staging expires and refuses oversized or truncated source streams without finishing a set',async t=>{
  const cwd=await temporary(t);const bytes=Buffer.from('fixture');
  const manager=createAttachmentPartRestores({cwd,env:{},retentionMs:20});t.after(()=>manager.close());
  await manager.restore(7,{payload:payload([chunk(bytes)])});
  await new Promise(resolve=>setTimeout(resolve,50));
  assert.throws(()=>manager.assertComplete(7,context.backupId,context.recordsChecksum,[attachmentFileId(descriptor)]),/all matching/);
  const env={AWS_S3_BUCKET_NAME:'backup-test',AWS_REGION:'ap-south-1'};
  const refs={files:[{storage:'s3',bucket:'backup-test',region:'ap-south-1',key:'docs/a'}]};
  for(const size of [bytes.length+1,bytes.length-1,513*1024*1024]) {
    await assert.rejects(exportAttachmentParts(refs,context,{env,s3Send:async()=>({ContentLength:size,Body:Readable.from([bytes])}),publish:()=>assert.fail('incomplete export was published')}));
  }
});
