// Synthetic legacy-engine baseline. No .env, application pool or network.
// Run: node scripts/bench/backup-legacy.bench.mjs [--sizes=16,64]
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { performance, monitorEventLoopDelay } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const childSize = process.argv.find(value => value.startsWith('--child='))?.split('=')[1];
if (childSize) {
  const mib = Number(childSize);
  if (!Number.isInteger(mib) || mib < 1 || mib > 64) throw new Error('Baseline sizes must be between 1 and 64 MiB.');
  const { PGlite } = await import('@electric-sql/pglite');
  const { exportBackup } = await import('../../src/services/backup.service.js');
  const sql = new PGlite();
  const rows = mib * 256;
  await sql.exec(`CREATE TABLE benchmark_records (id BIGSERIAL PRIMARY KEY, body TEXT NOT NULL);
    INSERT INTO benchmark_records(body) SELECT repeat(md5(n::text),128) FROM generate_series(1,${rows}) n;`);
  const query = async (text, values) => {
    const result = await sql.query(text, values);
    return { ...result, rowCount: result.affectedRows };
  };
  const db = { connect: async () => ({ query, release() {} }) };
  global.gc?.();
  const startMemory = process.memoryUsage(), startRss = startMemory.rss;
  let peakRss = startRss, peakHeap = startMemory.heapUsed;
  const sample = () => { const memory = process.memoryUsage(); peakRss = Math.max(peakRss, memory.rss); peakHeap = Math.max(peakHeap, memory.heapUsed); };
  const timer = setInterval(sample, 5);
  const delay = monitorEventLoopDelay({ resolution: 10 });
  delay.enable();
  await new Promise(resolve => setTimeout(resolve, 20));
  delay.reset();
  const cpuStart = process.cpuUsage(), start = performance.now();
  const result = await exportBackup(db, { month: '2026-11', includeFiles: false }, {
    onProgress: sample,
  });
  const durationMs = performance.now() - start, cpu = process.cpuUsage(cpuStart);
  sample();
  await new Promise(resolve => setTimeout(resolve, 20));
  clearInterval(timer); delay.disable();
  const report = { fixture_mib: mib, rows, payload_text_bytes: rows * 4096,
    archive_bytes: result.buffer.length, duration_ms: +durationMs.toFixed(2),
    rss_before_bytes: startRss, peak_sampled_rss_bytes: peakRss, rss_growth_bytes: peakRss - startRss,
    heap_before_bytes: startMemory.heapUsed, peak_sampled_heap_bytes: peakHeap, heap_growth_bytes: peakHeap - startMemory.heapUsed,
    process_lifetime_max_rss_bytes: process.resourceUsage().maxRSS * 1024,
    cpu_user_ms: +(cpu.user / 1000).toFixed(2), cpu_system_ms: +(cpu.system / 1000).toFixed(2),
    event_loop_p95_ms: +(delay.percentile(95) / 1e6).toFixed(2), event_loop_max_ms: +(delay.max / 1e6).toFixed(2),
    logical_throughput_mib_s: +(mib / (durationMs / 1000)).toFixed(2),
    held_rows_after_export: result.payload.tables.reduce((count, table) => count + table.rows.length, 0) };
  await sql.close();
  console.log(JSON.stringify(report));
} else {
  const sizes = (process.argv.find(value => value.startsWith('--sizes='))?.split('=')[1] || '16,64').split(',').map(Number);
  const results = [];
  for (const size of sizes) {
    const child = spawn(process.execPath, ['--expose-gc', '--max-old-space-size=1024', fileURLToPath(import.meta.url), `--child=${size}`], {
      env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, BACKUP_MAX_EXPANDED_MB: '100' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', value => { stdout += value; });
    child.stderr.on('data', value => { stderr = (stderr + value).slice(-8000); });
    const timeout = setTimeout(() => child.kill('SIGKILL'), 180000);
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
    clearTimeout(timeout);
    if (code !== 0) throw new Error(`Baseline child ${size} MiB failed (${code}): ${stderr}`);
    const result = JSON.parse(stdout.trim()); results.push(result); console.log(JSON.stringify(result));
  }
  const source = await readFile(new URL('../../src/services/backup.service.js', import.meta.url));
  const report = { recorded_at: new Date().toISOString(), scope: 'Synthetic PGlite fixture, real legacy exportBackup; no production database/API/storage. PGlite database memory is in the same process and affects absolute RSS. The fixture repeats a per-row MD5 string, so compression is not representative of attachments.',
    engine_sha256: createHash('sha256').update(source).digest('hex'), node: process.version,
    host: { platform: process.platform, arch: process.arch, cpus: os.cpus().length, memory_bytes: os.totalmem() }, results,
    unmeasured: ['production API p95/p99', 'native database CPU/I/O', 'S3 throughput', 'production OOM trace', '1/5/10 GB legacy exports exceed the supported 100 MiB default and were not attempted'] };
  await mkdir(new URL('../../benchmarks/', import.meta.url), { recursive: true });
  await writeFile(new URL('../../benchmarks/backup-legacy.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
}
