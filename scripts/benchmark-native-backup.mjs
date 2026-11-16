// Explicit local synthetic benchmark. Never loads .env or the application pool.
// BACKUP_NATIVE_TEST_DATABASE_URL=postgresql://user@127.0.0.1:55439/backup_engine_test \
// BACKUP_PG_DUMP=/path/to/pg_dump BACKUP_PG_RESTORE=/path/to/pg_restore \
// node scripts/benchmark-native-backup.mjs --sizes=16,64,1024
import pg from 'pg';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { performance, monitorEventLoopDelay } from 'node:perf_hooks';
import { fixtureStorage, isolatedTestUrl } from '../test/helpers/nativeBackupFixture.mjs';
import { getNativeBackupConfig } from '../src/services/nativeBackupConfig.js';
import { executeNativeBackup } from '../src/services/nativeBackupEngine.js';
import { exportBackup } from '../src/services/backup.service.js';

const url = isolatedTestUrl(process.env.BACKUP_NATIVE_TEST_DATABASE_URL);
const arg = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const mode = arg('child');
const round = value => +value.toFixed(2);
const percentile = (values, p) => [...values].sort((a,b) => a-b)[Math.max(0, Math.ceil(values.length * p)-1)] || 0;
if (mode) {
  const size = Number(arg('mib'));
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'native-backup-benchmark-'));
  const probe = new pg.Client({ connectionString: url.href }); await probe.connect();
  const source = new pg.Pool({ connectionString: url.href, max: 1 });
  const config = getNativeBackupConfig({ BACKUP_DATABASE_URL: url.href, BACKUP_ENABLED: 'true', BACKUP_S3_BUCKET: 'test',
    BACKUP_PG_DUMP: process.env.BACKUP_PG_DUMP || 'pg_dump', BACKUP_PG_RESTORE: process.env.BACKUP_PG_RESTORE || 'pg_restore',
    BACKUP_COMPRESSION: mode === 'native-3' ? '3' : '1' });
  global.gc?.(); const before = process.memoryUsage(); let peak = { ...before };
  const sample = () => { const value = process.memoryUsage(); for (const key of ['rss','heapUsed','external']) peak[key] = Math.max(peak[key], value[key]); };
  const timer = setInterval(sample, 5), delays = monitorEventLoopDelay({ resolution: 10 }); delays.enable();
  await new Promise(resolve => setTimeout(resolve, 20)); delays.reset();
  const latencies = []; let probing = true;
  const reading = (async () => {
    while (probing) {
      const start = performance.now(); await probe.query('SELECT body FROM benchmark_records WHERE id=$1', [1]);
      latencies.push(performance.now() - start); await new Promise(resolve => setTimeout(resolve, 10));
    }
  })();
  const cpuStart = process.cpuUsage(), start = performance.now(); let bytes;
  try {
    if (mode === 'legacy') {
      const result = await exportBackup(source, { month: '2026-11', includeFiles: false }, { onProgress: sample });
      bytes = result.buffer.length; sample();
    } else {
      const id = randomUUID();
      const result = await executeNativeBackup({ config, storage: fixtureStorage(root, { onChunk: sample }), metadata: source,
        job: { id, kind: 'backup', scope: 'database', attempt: 1, artifactPrefix: `native-backups/${id}/attempt-1-${randomUUID()}/` },
        signal: AbortSignal.timeout(180000), progress: sample });
      bytes = result.bytes; sample();
    }
    const duration = performance.now() - start, cpu = process.cpuUsage(cpuStart);
    probing = false; await reading; clearInterval(timer); delays.disable();
    console.log(JSON.stringify({ mode, fixture_mib: size, logical_payload_bytes: size * 1024 ** 2, archive_bytes: bytes,
      duration_ms: round(duration), logical_mib_per_second: round(size / (duration / 1000)),
      node_rss_before_bytes: before.rss, node_peak_sampled_rss_bytes: peak.rss, node_peak_lifetime_rss_bytes: process.resourceUsage().maxRSS * 1024,
      node_heap_before_bytes: before.heapUsed, node_peak_sampled_heap_bytes: peak.heapUsed,
      node_cpu_user_ms: round(cpu.user / 1000), node_cpu_system_ms: round(cpu.system / 1000),
      event_loop_p95_ms: round(delays.percentile(95) / 1e6), event_loop_max_ms: round(delays.max / 1e6),
      concurrent_indexed_read: { samples: latencies.length, p95_ms: round(percentile(latencies,.95)), p99_ms: round(percentile(latencies,.99)) },
      temporary_artifact_bytes: mode === 'legacy' ? 0 : bytes }));
  } finally { probing = false; clearInterval(timer); delays.disable(); await reading; await source.end(); await probe.end(); await fs.rm(root, { recursive: true, force: true }); }
} else {
  const sizes = (arg('sizes') || '16,64').split(',').map(Number);
  if (sizes.some(size => !Number.isInteger(size) || size < 1 || size > 10240)) throw new Error('Benchmarks cap synthetic fixtures at 10240 MiB.');
  const admin = new pg.Client({ connectionString: url.href }); await admin.connect();
  const results = [];
  try {
    for (const size of sizes) {
      const database = `backup_benchmark_${randomUUID().replaceAll('-','')}_test`;
      await admin.query(`CREATE DATABASE ${database} TEMPLATE template0`);
      const fixture = new URL(url); fixture.pathname = `/${database}`;
      try {
        const seed = new pg.Client({ connectionString: fixture.href }); await seed.connect();
        try {
          await seed.query(`CREATE TABLE benchmark_records(id BIGSERIAL PRIMARY KEY,body TEXT NOT NULL);
            INSERT INTO benchmark_records(body) SELECT repeat(md5(n::text),128) FROM generate_series(1,${size * 256}) n;
            ANALYZE benchmark_records;`);
        } finally { await seed.end(); }
        for (const candidate of [...(size <= 64 ? ['legacy'] : []), 'native-1', ...(size === 64 ? ['native-3'] : [])]) {
          const child = spawn(process.execPath, ['--expose-gc',`--max-old-space-size=${candidate === 'legacy' ? 1024 : 192}`,fileURLToPath(import.meta.url),`--child=${candidate}`,`--mib=${size}`], {
            env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, BACKUP_NATIVE_TEST_DATABASE_URL: fixture.href,
              BACKUP_PG_DUMP: process.env.BACKUP_PG_DUMP, BACKUP_PG_RESTORE: process.env.BACKUP_PG_RESTORE }, stdio: ['ignore','pipe','pipe'],
          });
          let stdout = '', stderr = ''; child.stdout.on('data', value => { stdout += value; }); child.stderr.on('data', value => { stderr = (stderr + value).slice(-8000); });
          const timeout = setTimeout(() => child.kill('SIGKILL'), 210000);
          const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); }); clearTimeout(timeout);
          if (code !== 0) throw new Error(`Benchmark ${candidate}/${size} failed (${code}): ${stderr}`);
          const result = JSON.parse(stdout.trim()); results.push(result); console.log(JSON.stringify(result));
        }
      } finally { await admin.query(`DROP DATABASE ${database} WITH (FORCE)`); }
    }
  } finally { await admin.end(); }
  const report = { recorded_at: new Date().toISOString(), scope: 'Synthetic isolated PostgreSQL 18.4 on loopback; identical repeated-MD5 text fixtures. Legacy returns buffered archive; native includes filesystem streaming upload, archive parsing and full checksum readback. This is not production API/S3 throughput.',
    node: process.version, platform: process.platform, arch: process.arch, fixture: '4096-byte repeated per-row MD5 strings; very compressible and not representative of encrypted files/media.',
    limits: 'PostgreSQL 64 MiB shared_buffers, max_connections 12, fsync off for disposable fixture. Node heap cap 192 MiB native / 1024 MiB legacy. One backup process at a time.', results,
    unmeasured: ['production HTTP API p95/p99','S3 network/multipart performance','pg_dump and server CPU/RSS','hosted quotas and storage costs','production restore duration'] };
  await fs.mkdir(new URL('../benchmarks/', import.meta.url), { recursive: true });
  const reportName = arg('report') || 'backup-native.json';
  if (!/^[a-z0-9-]+\.json$/.test(reportName)) throw new Error('Invalid benchmark report name.');
  await fs.writeFile(new URL(`../benchmarks/${reportName}`, import.meta.url), JSON.stringify(report,null,2)+'\n');
}
