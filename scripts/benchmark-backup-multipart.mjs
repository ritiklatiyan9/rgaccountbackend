import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { performance, monitorEventLoopDelay } from 'node:perf_hooks';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { createNativeBackupStorage } from '../src/services/nativeBackupStorage.js';

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;
const filename = fileURLToPath(import.meta.url);
const childSize = process.argv.find(arg => arg.startsWith('--child='))?.slice(8);

async function measure(gib) {
  if (!Number.isInteger(gib) || gib < 1 || gib > 100) throw new Error('Synthetic size must be an integer from 1 to 100 GiB.');
  const totalBytes = gib * GIB;
  const partSize = 8 * MIB;
  const chunk = Buffer.alloc(64 * 1024, 0x65);
  const lag = monitorEventLoopDelay({ resolution: 5 });
  let peakRss = process.memoryUsage().rss, peakHeap = process.memoryUsage().heapUsed;
  let receivedBytes = 0, parts = 0, activeParts = 0, peakActiveParts = 0, largestPart = 0;
  const sample = () => { const mem=process.memoryUsage();peakRss=Math.max(peakRss,mem.rss);peakHeap=Math.max(peakHeap,mem.heapUsed); };
  const sampler = setInterval(sample, 5);
  lag.enable();
  const beforeCpu = process.cpuUsage();
  const started = performance.now();
  const client = {
    config: { requestHandler: {}, endpoint: async () => ({protocol:'https:',hostname:'synthetic.invalid'}) },
    async send(command,{abortSignal}={}) {
      if(abortSignal?.aborted) throw abortSignal.reason;
      switch(command.constructor.name) {
        case 'CreateMultipartUploadCommand': return { UploadId:'synthetic-upload' };
        case 'UploadPartCommand': {
          assertBuffer(command.input.Body);
          const bytes = command.input.Body.length;
          activeParts++;peakActiveParts=Math.max(peakActiveParts,activeParts);largestPart=Math.max(largestPart,bytes);sample();
          try { await nextTurn(); if(abortSignal?.aborted) throw abortSignal.reason;receivedBytes+=bytes;parts++;return { ETag:`"part-${command.input.PartNumber}"` }; }
          finally { sample();activeParts--; }
        }
        case 'CompleteMultipartUploadCommand': return { ETag:'"synthetic-complete"',VersionId:'synthetic-version' };
        case 'AbortMultipartUploadCommand': return {};
        default: throw new Error(`Unexpected command ${command.constructor.name}`);
      }
    },
  };
  const storage = createNativeBackupStorage({ prefix:'bench',bucket:'synthetic-only',region:'ap-south-1',partSize,uploadConcurrency:2,maxArchiveBytes:100*GIB },{client});
  async function* chunks() { for(let bytes=0;bytes<totalBytes;bytes+=chunk.length) yield chunk; }
  try {
    const archive = await storage.upload('bench/fixture/database.dump',Readable.from(chunks(),{objectMode:false,highWaterMark:64*1024}));
    sample();
    const durationMs = performance.now()-started;
    const cpu=process.cpuUsage(beforeCpu);
    if(archive.bytes!==totalBytes || receivedBytes!==totalBytes || largestPart>partSize || peakActiveParts>2) throw new Error('Synthetic multipart byte or concurrency invariant failed.');
    return {
      generatedGiB:gib,generatedBytes:totalBytes,receivedBytes,checksum:archive.checksum,
      durationMs:+durationMs.toFixed(2),throughputMiBPerSecond:+(totalBytes/MIB/(durationMs/1000)).toFixed(2),
      peakRssMiB:+(peakRss/MIB).toFixed(2),peakHeapMiB:+(peakHeap/MIB).toFixed(2),
      cpuUserMs:+(cpu.user/1000).toFixed(2),cpuSystemMs:+(cpu.system/1000).toFixed(2),
      cpuPercent:+((cpu.user+cpu.system)/(durationMs*1000)*100).toFixed(2),
      eventLoopP95Ms:+(lag.percentile(95)/1e6).toFixed(2),eventLoopP99Ms:+(lag.percentile(99)/1e6).toFixed(2),eventLoopMaxMs:+(lag.max/1e6).toFixed(2),
      partCount:parts,partSizeMiB:partSize/MIB,largestPartMiB:largestPart/MIB,peakConcurrentParts:peakActiveParts,
      nodeVersion:process.version,platform:process.platform,architecture:process.arch,nodeHeapLimitMiB:192,
      temporaryDiskBytes:0,networkRequests:0,
    };
  } finally {clearInterval(sampler);lag.disable();}
}
function assertBuffer(value) { if(!Buffer.isBuffer(value) && !(value instanceof Uint8Array)) throw new Error('SDK did not supply a bounded binary part.'); }

if(childSize) console.log(JSON.stringify(await measure(Number(childSize))));
else {
  const sizes = (process.argv.find(arg=>arg.startsWith('--gib='))?.slice(6)||'1,5,10').split(',').map(Number);
  const results=[];
  for(const size of sizes) {
    const result = await new Promise((resolve,reject)=>{
      const child=spawn(process.execPath,['--max-old-space-size=192',filename,`--child=${size}`],{stdio:['ignore','pipe','pipe'],env:{PATH:process.env.PATH}});
      let out='',error='';
      child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
      child.stdout.on('data',chunk=>{out+=chunk;if(out.length>65536)child.kill();});
      child.stderr.on('data',chunk=>{error=(error+chunk).slice(-4096);});
      child.once('error',reject);
      child.once('close',code=>{if(code!==0)reject(new Error(`Synthetic ${size} GiB child failed (${code}): ${error}`));else{try{resolve(JSON.parse(out));}catch(cause){reject(cause);}}});
    });
    results.push(result);
    console.log(JSON.stringify({syntheticGiB:size,peakRssMiB:result.peakRssMiB,durationMs:result.durationMs}));
  }
  const report={
    generatedAt:new Date().toISOString(),
    scope:'Synthetic transport-only benchmark of the actual installed @aws-sdk/lib-storage Upload through nativeBackupStorage. Generated 64 KiB chunks; fake S3 client discards bounded multipart buffers. No database, compression, disk writes, cloud network or real S3 throughput measured.',
    limitations:['Does not establish production API latency, database load, cloud throughput, recoverability or cost.','Each size runs in a fresh Node process with a 192 MiB V8 heap cap; RSS also includes SDK buffers and native allocations.','Source bytes are generated, not representative ERP data.'],
    results,
  };
  const output=path.resolve('benchmarks/backup-multipart.json');
  await fs.mkdir(path.dirname(output),{recursive:true});await fs.writeFile(output,`${JSON.stringify(report,null,2)}\n`);
  console.log(`Saved ${output}`);
}
