import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { createBackupExportJobs } from '../src/services/backupExportJobs.js';

const archive = {buffer:Buffer.from('fixture archive'),filename:'fixture.accounts-backup.json.gz',checksum:'a'.repeat(64)};
async function finished(jobs,id,owner=7) {
  for (let i=0;i<500;i++) {
    const job=jobs.status(id,owner);
    if (job.status!=='preparing') return job;
    await delay(5);
  }
  assert.fail('Export did not finish');
}

test('preparation returns immediately, reports progress and downloads only a complete private archive',async t=>{
  let complete;
  const waiting=new Promise(resolve=>{complete=resolve;});
  let releases=0;
  const jobs=createBackupExportJobs({generate:async(input,progress)=>{
    assert.equal(input.month,'2026-10');
    progress({stage:'reading',rows:5000});
    await waiting;
    return archive;
  }});
  t.after(()=>jobs.close());
  const job=await jobs.start(7,{month:'2026-10'},()=>{releases++;});
  assert.equal(job.status,'preparing');
  assert.equal(jobs.status(job.id,7).progress.rows,5000);
  assert.throws(()=>jobs.file(job.id,7),error=>error.statusCode===409);
  assert.throws(()=>jobs.status(job.id,8),error=>error.statusCode===404);
  assert.throws(()=>jobs.file(job.id,8),error=>error.statusCode===404);
  await assert.rejects(jobs.start(7,{}),error=>error.statusCode===409);
  complete();
  const ready=await finished(jobs,job.id);
  assert.equal(ready.status,'ready');
  assert.equal(ready.bytes,archive.buffer.length);
  assert.equal(ready.checksum,archive.checksum);
  assert.equal(releases,1);
  const file=jobs.file(job.id,7);
  assert.deepEqual(await fs.readFile(file.path),archive.buffer);
  assert.equal((await fs.stat(file.path)).mode & 0o777,0o600);
  assert.equal((await fs.stat(path.dirname(file.path))).mode & 0o777,0o700);
  assert.deepEqual(jobs.file(job.id,7),file); // safe to retry a download
  await jobs.close();
  await assert.rejects(fs.stat(file.path),error=>error.code==='ENOENT');
});

test('storage failures are reported without offering an incomplete download',async t=>{
  let reported=false,unlocked=false;
  const jobs=createBackupExportJobs({
    generate:async()=>{throw Object.assign(new Error('Attachment storage access denied.'),{statusCode:400});},
    onError:()=>{reported=true;throw new Error('broken logger');},
  });
  t.after(()=>jobs.close());
  const job=await jobs.start(7,{},()=>{unlocked=true;});
  const failed=await finished(jobs,job.id);
  assert.equal(failed.status,'failed');
  assert.equal(failed.errorStatus,400);
  assert.equal(failed.message,'Attachment storage access denied.');
  assert.ok(reported && unlocked);
  assert.throws(()=>jobs.file(job.id,7),/access denied/);
});

test('internal errors do not disclose database details and old temporary archives expire',async t=>{
  const jobs=createBackupExportJobs({retentionMs:30,generate:async()=>{throw new Error('sensitive internal details');}});
  t.after(()=>jobs.close());
  const job=await jobs.start(7,{});
  const failed=await finished(jobs,job.id);
  assert.doesNotMatch(failed.message,/sensitive internal/);
  await delay(60);
  assert.throws(()=>jobs.status(job.id,7),error=>error.statusCode===404);
});

test('retained archives are bounded and eviction removes the oldest private file',async t=>{
  const jobs=createBackupExportJobs({maxRetained:2,generate:async()=>archive});
  t.after(()=>jobs.close());
  const first=await jobs.start(7,{});await finished(jobs,first.id);
  const file=jobs.file(first.id,7);
  const second=await jobs.start(7,{});await finished(jobs,second.id);
  const third=await jobs.start(7,{});await finished(jobs,third.id);
  assert.throws(()=>jobs.status(first.id,7),error=>error.statusCode===404);
  await assert.rejects(fs.stat(file.path),error=>error.code==='ENOENT');
  assert.equal(jobs.status(second.id,7).status,'ready');
  assert.equal(jobs.status(third.id,7).status,'ready');
});

test('startup removes abandoned private exports while preserving fresh directories and unrelated files',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'backup-job-cleanup-test-'));
  const stale=path.join(root,'accounts-backup-export-stale');
  const fresh=path.join(root,'accounts-backup-export-fresh');
  const unrelated=path.join(root,'other-backup');
  for(const directory of [stale,fresh,unrelated]) {await fs.mkdir(directory,{mode:0o700});await fs.writeFile(path.join(directory,'archive.gz'),'fixture',{mode:0o600});}
  const old=new Date(Date.now()-4*60*60*1000);
  await fs.utimes(stale,old,old);await fs.utimes(unrelated,old,old);
  const jobs=createBackupExportJobs({temporaryRoot:root,generate:async()=>archive});
  t.after(async()=>{await jobs.close();await fs.rm(root,{recursive:true,force:true});});
  const job=await jobs.start(7,{});await finished(jobs,job.id);
  await assert.rejects(fs.stat(stale),error=>error.code==='ENOENT');
  assert.ok((await fs.stat(fresh)).isDirectory());
  assert.ok((await fs.stat(unrelated)).isDirectory());
});

test('multipart jobs expose every part only after completion and keep ownership on retries',async t=>{
  const jobs=createBackupExportJobs({generate:async(_input,_progress,publish)=>{
    await publish({...archive,kind:'records'});
    await publish({...archive,filename:'part-2.gz',kind:'attachments'});
    return {multipart:true,backupId:'fixture-id'};
  }});t.after(()=>jobs.close());
  const job=await jobs.start(7,{});const ready=await finished(jobs,job.id);
  assert.equal(ready.multipart,true);assert.equal(ready.parts.length,2);
  assert.ok(new Date(ready.expiresAt).getTime()-Date.now()>119*60*1000);
  assert.equal(jobs.file(job.id,7,2).filename,'part-2.gz');
  assert.throws(()=>jobs.file(job.id,8,2),error=>error.statusCode===404);
  assert.throws(()=>jobs.file(job.id,7,3),error=>error.statusCode===404);
});

test('failure after writing some parts removes the incomplete set and offers no downloads',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'backup-job-failure-test-'));
  const jobs=createBackupExportJobs({temporaryRoot:root,generate:async(_input,_progress,publish)=>{
    await publish(archive);throw Object.assign(new Error('Original missing'),{statusCode:400});
  }});t.after(async()=>{await jobs.close();await fs.rm(root,{recursive:true,force:true});});
  const job=await jobs.start(7,{});assert.equal((await finished(jobs,job.id)).status,'failed');
  assert.throws(()=>jobs.file(job.id,7,1),/Original missing/);
  assert.deepEqual(await fs.readdir(root),[]);
});

test('concurrent starts reserve preparation before asynchronous filesystem work',async t=>{
  let complete;const waiting=new Promise(resolve=>{complete=resolve;});
  const jobs=createBackupExportJobs({generate:async()=>{await waiting;return archive;}});
  t.after(()=>jobs.close());
  const first=jobs.start(7,{});
  await assert.rejects(jobs.start(7,{}),error=>error.statusCode===409);
  const job=await first;
  complete();
  assert.equal((await finished(jobs,job.id)).status,'ready');
});
