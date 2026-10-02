import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { createReadStream, constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { attachmentReferences, localDirectory, objectSender, validateAttachments } from './backupAttachments.js';
import { BACKUP_FORMAT, decodeArchive, encodeArchiveWithMetadata, getBackupLimits, validateBackupPayload } from './backupArchive.js';

export const ATTACHMENT_PART_FORMAT='rgaccounts-attachment-part';
const MIB=1024*1024;
const fail=(message,statusCode=400)=>{throw Object.assign(new Error(message),{statusCode});};
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
export const attachmentFileId=file=>hash(JSON.stringify([file.storage,file.bucket || '',file.key]));
const integer=(value,min,max)=>Number.isSafeInteger(value) && value>=min && value<=max;
const digest=value=>typeof value==='string' && /^[a-f0-9]{64}$/.test(value);
const uuid=value=>typeof value==='string' && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value);
const mb=(value,fallback,max)=>integer(Number(value),1,max) ? Number(value)*MIB : fallback*MIB;

export function getAttachmentSetLimits() {
  const limits=getBackupLimits();
  const partBytes=Math.min(24*MIB,Math.floor((Math.min(limits.maxExpandedBytes,limits.maxUploadBytes)-65536)*0.65));
  return {partBytes,chunkBytes:Math.min(3*MIB,partBytes),maxSetBytes:mb(process.env.BACKUP_MAX_ATTACHMENT_SET_MB,2048,8192),
    maxFileBytes:mb(process.env.BACKUP_MAX_ATTACHMENT_FILE_MB,512,2048)};
}

export function validateAttachmentPart(payload,options={}) {
  if(!payload || !uuid(payload.backupId) || !digest(payload.recordsChecksum) || !/^\d{4}-(0[1-9]|1[0-2])$/.test(payload.month || '') || !integer(payload.partIndex,2,100000) || !Array.isArray(payload.chunks) || !payload.chunks.length || payload.chunks.length>200) fail('Attachment backup part metadata is invalid.');
  const limits=getAttachmentSetLimits();
  let totalBytes=0;const seen=new Set();
  for(const chunk of payload.chunks) {
    validateAttachments({version:1,files:[chunk],external:[]},options);
    if(chunk.fileId!==attachmentFileId(chunk) || !integer(chunk.fileSize,0,limits.maxFileBytes) || !integer(chunk.chunkSize,65536,limits.chunkBytes)
      || chunk.chunkCount!==Math.max(1,Math.ceil(chunk.fileSize/chunk.chunkSize)) || !integer(chunk.chunkIndex,0,chunk.chunkCount-1)
      || chunk.offset!==chunk.chunkIndex*chunk.chunkSize) fail('Attachment backup chunk metadata is invalid.');
    const bytes=Buffer.from(chunk.data,'base64');
    totalBytes+=bytes.length;
    const identity=`${chunk.fileId}:${chunk.chunkIndex}`;
    if(seen.has(identity)) fail('Attachment part contains a duplicate chunk.');
    seen.add(identity);
    const expected=Math.min(chunk.chunkSize,chunk.fileSize-chunk.offset);
    if(bytes.length!==expected || (chunk.chunkIndex===chunk.chunkCount-1 ? !digest(chunk.fileSha256) : chunk.fileSha256!==undefined)) fail('Attachment backup chunk is incomplete.');
  }
  if(totalBytes>limits.partBytes) fail('Attachment part exceeds the configured part size.',413);
}

export async function decodeBackupPart(buffer,options={}) {
  return decodeArchive(buffer,{formats:[BACKUP_FORMAT,ATTACHMENT_PART_FORMAT],validate:(payload,format)=>{
    if(format===BACKUP_FORMAT) validateBackupPayload(payload);
    else validateAttachmentPart(payload,options);
  }});
}

export function attachmentPartPreview(decoded) {
  const {payload,checksum}=decoded;
  return {kind:'attachment-part',backupId:payload.backupId,recordsChecksum:payload.recordsChecksum,partIndex:payload.partIndex,checksum,compatible:true,
    chunks:payload.chunks.map(({data,...chunk})=>({...chunk,bytes:Buffer.from(data,'base64').length})),
    attachmentBytes:payload.chunks.reduce((n,chunk)=>n+Buffer.from(chunk.data,'base64').length,0)};
}

async function sourceFile(file,options,send) {
  if(file.storage==='local') {
    const directory=await localDirectory(file.key,options.cwd || process.cwd(),false);
    const handle=await fs.open(path.join(directory,file.key.split('/')[1]),constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat=await handle.stat();
    if(!stat.isFile()) {await handle.close();fail('Referenced attachment is not a regular file.');}
    return {size:stat.size,body:handle.createReadStream({autoClose:false}),close:()=>handle.close()};
  }
  const object=await send(file,new GetObjectCommand({Bucket:file.bucket,Key:file.key}));
  return {size:object.ContentLength,body:object.Body,contentType:object.ContentType,close:async()=>object.Body?.destroy?.()};
}

async function* fileChunks(file,options,send) {
  let source,timer;
  try {
    source=await sourceFile(file,options,send);
    const limits=getAttachmentSetLimits();
    if(!integer(source.size,0,limits.maxFileBytes)) fail(`Original file exceeds the ${limits.maxFileBytes/MIB} MiB per-file limit or its length is unknown.`,413);
    if(!source.body || typeof source.body[Symbol.asyncIterator]!=='function') fail('Attachment storage returned an unreadable file.');
    timer=setTimeout(()=>source.body.destroy?.(Object.assign(new Error('Original file read timed out'),{code:'ETIMEDOUT'})),options.readTimeoutMs || 10*60*1000);timer.unref();
    const chunkSize=options.chunkBytes || limits.chunkBytes;
    const chunkCount=Math.max(1,Math.ceil(source.size/chunkSize));
    const fileId=attachmentFileId(file);const checksum=crypto.createHash('sha256');
    let buffer=Buffer.allocUnsafe(chunkSize),used=0,total=0,index=0;
    const descriptor={...file,fileId,fileSize:source.size,chunkSize,chunkCount,...(source.contentType ? {contentType:source.contentType} : {})};
    for await(const raw of source.body) {
      const bytes=Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      total+=bytes.length;
      if(total>source.size) fail('An original file changed size during backup. Prepare a new backup.');
      checksum.update(bytes);
      let offset=0;
      while(offset<bytes.length) {
        const length=Math.min(chunkSize-used,bytes.length-offset);
        bytes.copy(buffer,used,offset,offset+length);used+=length;offset+=length;
        if(used===chunkSize) {
          // Delay the last full chunk until EOF so the whole-file hash includes
          // every byte and a truncated source cannot look like a complete file.
          if(index===chunkCount-1) continue;
          yield {...descriptor,chunkIndex:index,offset:index*chunkSize,data:buffer.toString('base64'),sha256:hash(buffer)};
          index++;buffer=Buffer.allocUnsafe(chunkSize);used=0;
        }
      }
    }
    if(total!==source.size) fail('An original file was incomplete during backup. Prepare a new backup.');
    const final=buffer.subarray(0,used);
    yield {...descriptor,chunkIndex:index,offset:index*chunkSize,data:final.toString('base64'),sha256:hash(final),fileSha256:checksum.digest('hex')};
  } catch(error) {
    if(error.statusCode) throw error;
    fail(`Cannot back up original ${file.key} (${error.code || error.name}). Restore storage read access and try again.`);
  } finally {clearTimeout(timer);source?.body?.destroy?.();await source?.close?.().catch(()=>{});}
}

/** Each yielded archive stays below the existing per-upload/expanded limits. */
export async function exportAttachmentParts(refs,context,options={}) {
  const limits=getAttachmentSetLimits();const send=objectSender({...options,timeoutMs:10*60*1000});
  const archiveLimits=getBackupLimits();
  const jsonBudget=Math.min(archiveLimits.maxExpandedBytes,archiveLimits.maxUploadBytes)-65536;
  let chunks=[],bytes=0,jsonBytes=0,total=0,partIndex=2,completed=0;
  async function publish() {
    if(!chunks.length) return;
    const payload={backupId:context.backupId,recordsChecksum:context.recordsChecksum,month:context.month,partIndex,chunks};
    const encoded=await encodeArchiveWithMetadata(payload,{format:ATTACHMENT_PART_FORMAT,validate:value=>validateAttachmentPart(value,options)});
    await options.publish({...encoded,kind:'attachments',filename:`accounts-${context.month}-part-${String(partIndex).padStart(5,'0')}-attachments-${context.backupId.slice(0,8)}.accounts-backup.json.gz`});
    partIndex++;chunks=[];bytes=0;jsonBytes=0;
  }
  for(const file of refs.files) {
    for await(const chunk of fileChunks(file,options,send)) {
      const length=Buffer.from(chunk.data,'base64').length;
      // Include path/content-type metadata as well as base64 bytes when grouping
      // parts, especially when the installation sets a small archive limit.
      const encodedBytes=chunk.data.length+Buffer.byteLength(JSON.stringify({...chunk,data:''}))+1;
      total+=length;
      if(total>limits.maxSetBytes) fail(`Originals exceed the ${limits.maxSetBytes/MIB} MiB total attachment-set limit. The set was not completed.`,413);
      if(bytes+length>limits.partBytes || jsonBytes+encodedBytes>jsonBudget || chunks.length>=200) await publish();
      chunks.push(chunk);bytes+=length;jsonBytes+=encodedBytes;
      options.onProgress?.({stage:'attachments',files:completed,totalFiles:refs.files.length,bytes:total});
    }
    completed++;
  }
  await publish();
  return {fileCount:completed,partCount:partIndex-2,attachmentBytes:total};
}

async function fileHash(filename) {
  const checksum=crypto.createHash('sha256');let bytes=0;
  for await(const chunk of createReadStream(filename,{flags:constants.O_RDONLY | constants.O_NOFOLLOW})) {bytes+=chunk.length;checksum.update(chunk);}
  return {sha256:checksum.digest('hex'),bytes};
}

async function installFile(file,filename,options) {
  if(file.storage==='local') {
    const directory=await localDirectory(file.key,options.cwd || process.cwd(),true);
    const destination=path.join(directory,file.key.split('/')[1]);
    const temporary=path.join(directory,`.backup-${crypto.randomUUID()}.tmp`);
    try {
      await fs.copyFile(filename,temporary,constants.COPYFILE_EXCL);await fs.chmod(temporary,0o600);
      try {await fs.link(temporary,destination);return 'created';} catch(error) {if(error.code!=='EEXIST') throw error;}
      const existing=await fileHash(destination);
      if(existing.sha256!==file.fileSha256 || existing.bytes!==file.fileSize) fail(`Original ${file.key} already exists with different contents. No file was overwritten.`);
      return 'reused';
    } finally {await fs.unlink(temporary).catch(()=>{});}
  }
  const send=objectSender({...options,timeoutMs:10*60*1000});
  async function existing() {
    let object,timer;
    try {object=await send(file,new GetObjectCommand({Bucket:file.bucket,Key:file.key}));}
    catch(error) {if(error.name==='NoSuchKey' || error.name==='NotFound' || error.$metadata?.httpStatusCode===404) return false;throw error;}
    const checksum=crypto.createHash('sha256');let bytes=0;
    timer=setTimeout(()=>object.Body?.destroy?.(Object.assign(new Error('Original file check timed out'),{code:'ETIMEDOUT'})),options.readTimeoutMs || 10*60*1000);timer.unref();
    try {
      for await(const chunk of object.Body) {bytes+=chunk.length;if(bytes>file.fileSize) fail(`Original ${file.key} already exists with different contents.`);checksum.update(chunk);}
      if(bytes!==file.fileSize || checksum.digest('hex')!==file.fileSha256) fail(`Original ${file.key} already exists with different contents. No file was overwritten.`);
      return true;
    } finally {clearTimeout(timer);object.Body?.destroy?.();}
  }
  if(await existing()) return 'reused';
  const body=createReadStream(filename);
  try {
    await send(file,new PutObjectCommand({Bucket:file.bucket,Key:file.key,Body:body,ContentLength:file.fileSize,ContentType:file.contentType || 'application/octet-stream',IfNoneMatch:'*'}));
    return 'created';
  } catch(error) {if(error.$metadata?.httpStatusCode===412 && await existing()) return 'reused';throw error;}
  finally {body.destroy();}
}

/** Parts assemble on private disk; originals are installed only after full hash validation. */
export function createAttachmentPartRestores(options={}) {
  const sets=new Map();const retentionMs=options.retentionMs || 2*60*60*1000;
  const root=options.temporaryRoot || os.tmpdir();
  const cleanup=(async()=>{
    const names=await fs.readdir(root);
    await Promise.all(names.filter(name=>name.startsWith('accounts-backup-parts-')).map(async name=>{
      const directory=path.join(root,name);
      try {
        const stat=await fs.lstat(directory);
        if(stat.isDirectory() && !stat.isSymbolicLink() && (!process.getuid || stat.uid===process.getuid()) && Date.now()-stat.mtimeMs>3*60*60*1000) await fs.rm(directory,{recursive:true,force:true});
      } catch { /* Other processes may already have removed an expired set. */ }
    }));
  })().catch(()=>{});
  async function remove(set) {clearTimeout(set.timer);sets.delete(set.id);await fs.rm(set.directory,{recursive:true,force:true});}
  function touch(set) {clearTimeout(set.timer);set.timer=setTimeout(()=>{void remove(set).catch(()=>{});},retentionMs);set.timer.unref();}
  return {
    async restore(ownerId,decoded) {
      await cleanup;
      const payload=decoded.payload;validateAttachmentPart(payload,options);
      const id=`${ownerId}:${payload.backupId}:${payload.recordsChecksum}`;
      let set=sets.get(id);
      if(!set) {
        if(sets.size>=3) fail('Other attachment restores are staged. Finish them or retry after they expire.',409);
        set={id,directory:await fs.mkdtemp(path.join(root,'accounts-backup-parts-')),files:new Map(),completed:new Map(),totalBytes:0};sets.set(id,set);
      }
      await fs.utimes(set.directory,new Date(),new Date());
      touch(set);let created=0,reused=0;
      for(const chunk of payload.chunks) {
        const done=set.completed.get(chunk.fileId);
        if(done) {if(done.chunkHashes[chunk.chunkIndex]!==chunk.sha256 || (chunk.fileSha256 && chunk.fileSha256!==done.sha256)) fail('Attachment part conflicts with an already restored file.');if(chunk.chunkIndex===chunk.chunkCount-1) reused++;continue;}
        let file=set.files.get(chunk.fileId);
        if(!file) {
          if(set.files.size+set.completed.size>=100000 || set.totalBytes+chunk.fileSize>getAttachmentSetLimits().maxSetBytes) fail('Staged originals exceed the configured disk allowance.',413);
          file={filename:path.join(set.directory,crypto.randomUUID()),metadata:{...chunk,data:undefined},chunks:new Map()};
          await fs.writeFile(file.filename,Buffer.alloc(0),{flag:'wx',mode:0o600});set.files.set(chunk.fileId,file);set.totalBytes+=chunk.fileSize;
        }
        for(const field of ['storage','key','bucket','region','contentType','fileSize','chunkSize','chunkCount']) if(file.metadata[field]!==chunk[field]) fail('Attachment chunks have conflicting file metadata.');
        if(file.chunks.has(chunk.chunkIndex) && file.chunks.get(chunk.chunkIndex)!==chunk.sha256) fail('Attachment chunks have conflicting contents.');
        const bytes=Buffer.from(chunk.data,'base64');const handle=await fs.open(file.filename,constants.O_RDWR | constants.O_NOFOLLOW);
        try {let written=0;while(written<bytes.length) {const result=await handle.write(bytes,written,bytes.length-written,chunk.offset+written);if(!result.bytesWritten) fail('Could not stage an attachment chunk.',500);written+=result.bytesWritten;}}
        finally {await handle.close();}
        file.chunks.set(chunk.chunkIndex,chunk.sha256);
        if(chunk.fileSha256) file.metadata.fileSha256=chunk.fileSha256;
        if(file.chunks.size===chunk.chunkCount) {
          const actual=await fileHash(file.filename);
          if(actual.bytes!==chunk.fileSize || actual.sha256!==file.metadata.fileSha256) fail('Reassembled original checksum failed. No original was installed.');
          const installed=await installFile(file.metadata,file.filename,options);
          if(installed==='created') created++;else reused++;
          set.completed.set(chunk.fileId,{sha256:actual.sha256,chunkHashes:Object.fromEntries(file.chunks)});
          await fs.unlink(file.filename);set.files.delete(chunk.fileId);
        }
      }
      return {created,reused,completedFiles:set.completed.size,pendingFiles:set.files.size};
    },
    assertComplete(ownerId,backupId,recordsChecksum,requiredIds) {
      const set=sets.get(`${ownerId}:${backupId}:${recordsChecksum}`);
      if(requiredIds.length && (!set || requiredIds.some(id=>!set.completed.has(id)))) fail('Upload and restore all matching attachment parts before restoring the database records.',409);
    },
    async close() {await Promise.all([...sets.values()].map(remove));},
  };
}

export {attachmentReferences};
