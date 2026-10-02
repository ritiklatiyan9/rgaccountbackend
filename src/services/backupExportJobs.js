import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const failure = (message,statusCode) => Object.assign(new Error(message),{statusCode});
const DIRECTORY_PREFIX='accounts-backup-export-';

async function cleanAbandonedExports(root) {
  // A crash can leave a private file behind. Active preparations are capped at
  // 30 minutes and completed sets last two hours; allow three hours before removing
  // our own stale directories so another process's active export is untouched.
  const names=await fs.readdir(root);
  await Promise.all(names.filter(name=>name.startsWith(DIRECTORY_PREFIX)).map(async name=>{
    const directory=path.join(root,name);
    try {
      const stat=await fs.lstat(directory);
      if(stat.isDirectory() && !stat.isSymbolicLink() && (!process.getuid || stat.uid===process.getuid()) && Date.now()-stat.mtimeMs>3*60*60*1000) await fs.rm(directory,{recursive:true,force:true});
    } catch { /* Stale files can disappear during another process's cleanup. */ }
  }));
}

/** Prepare privately, then download only a completed archive in a short request. */
export function createBackupExportJobs({ generate, retentionMs=20*60*1000, maxRetained=3, onError=()=>{},temporaryRoot=os.tmpdir() }) {
  const jobs = new Map();
  let starting=false;
  const cleanup=cleanAbandonedExports(temporaryRoot).catch(()=>{});
  async function remove(job) {
    jobs.delete(job.id);
    clearTimeout(job.timer);
    if (job.directory) await fs.rm(job.directory,{recursive:true,force:true});
  }
  function owned(id,ownerId) {
    const job = jobs.get(id);
    if (!job || job.ownerId !== String(ownerId)) throw failure('This prepared backup has expired or the server restarted. Prepare a new backup.',404);
    return job;
  }
  function summary(job) {
    return { id:job.id,status:job.status,progress:job.progress,
      ...(job.status==='ready' ? {filename:job.filename,bytes:job.bytes,checksum:job.checksum,expiresAt:job.expiresAt} : {}),
      ...(job.status==='ready' && job.multipart ? {multipart:true,parts:job.parts,backupId:job.backupId} : {}),
      ...(job.status==='failed' ? {message:job.message,errorStatus:job.errorStatus} : {}) };
  }
  return {
    async start(ownerId,input,onFinished=()=>{}) {
      if(starting) throw failure('Another backup is being prepared. Please wait for it to finish.',409);
      starting=true;
      try {
      await cleanup;
      if ([...jobs.values()].some(job => job.status==='preparing')) throw failure('Another backup is being prepared. Please wait for it to finish.',409);
      // Limit sensitive temporary archives, even when users repeatedly export.
      while (jobs.size >= maxRetained) await remove(jobs.values().next().value);
      const job = {id:randomUUID(),ownerId:String(ownerId),status:'preparing',progress:{stage:'reading',rows:0},parts:[]};
      job.directory = await fs.mkdtemp(path.join(temporaryRoot,DIRECTORY_PREFIX));
      jobs.set(job.id,job);
      job.task = (async () => {
        try {
          const publish=async result=>{
            const index=job.parts.length+1;
            const filename=path.join(job.directory,`part-${index}.gz`);
            await fs.writeFile(filename,result.buffer,{flag:'wx',mode:0o600});
            job.parts.push({index,filename:result.filename,bytes:result.buffer.length,checksum:result.checksum,kind:result.kind || 'records'});
          };
          const result = await generate(input,progress => { job.progress=progress; },publish);
          if(result?.buffer) await publish(result);
          if(!job.parts.length) throw new Error('Backup generation produced no files.');
          job.multipart=result?.multipart===true;job.backupId=result?.backupId;
          const first=job.parts[0];
          job.filename=first.filename; job.checksum=first.checksum; job.bytes=first.bytes;
          job.status='ready'; job.expiresAt=new Date(Date.now()+(job.multipart ? Math.max(retentionMs,2*60*60*1000) : retentionMs)).toISOString();
        } catch (error) {
          job.errorStatus=error.statusCode || 500;
          job.message=job.errorStatus<500 ? error.message : 'The server could not prepare a complete backup. Your records have not been changed. Ask the server administrator to check the export logs.';
          try { onError(error,{id:job.id,progress:job.progress}); } catch { /* Reporting must not prevent cleanup. */ }
          await fs.rm(job.directory,{recursive:true,force:true}).catch(()=>{});
          job.status='failed';
        } finally {
          job.timer=setTimeout(()=>{ void remove(job).catch(()=>{}); },job.multipart ? Math.max(retentionMs,2*60*60*1000) : retentionMs);
          job.timer.unref();
          try { onFinished(); } catch { /* The job result remains available. */ }
        }
      })();
      return summary(job);
      } finally { starting=false; }
    },
    status(id,ownerId) { return summary(owned(id,ownerId)); },
    file(id,ownerId,index=1) {
      const job=owned(id,ownerId);
      if (job.status!=='ready') throw failure(job.message || 'The backup is still being prepared.',job.status==='failed' ? job.errorStatus : 409);
      const part=job.parts.find(part=>part.index===index);
      if(!part) throw failure('This backup part does not exist.',404);
      return {path:path.join(job.directory,`part-${index}.gz`),filename:part.filename,checksum:part.checksum,bytes:part.bytes};
    },
    async close() {
      await Promise.all([...jobs.values()].map(job => job.task));
      await Promise.all([...jobs.values()].map(remove));
    },
  };
}
