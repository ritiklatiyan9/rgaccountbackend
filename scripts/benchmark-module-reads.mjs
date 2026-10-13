import { PGlite } from '@electric-sql/pglite';
import { performance } from 'node:perf_hooks';
import assert from 'node:assert/strict';
import { loadReportRows, reportReadQueries } from '../src/services/reportRead.service.js';
import { loadClientDemographics, CLIENT_DEMOGRAPHICS_SCOPE, CLIENT_DEMOGRAPHICS_SQL } from '../src/services/clientDemographicsRead.service.js';
import { baselineReportRows, normaliseReportRows } from '../test/support/report-read-baseline.mjs';

// Completely isolated PostgreSQL/WASM fixture. Never reads application database
// credentials, opens an application pool, or changes customer records.
const db = new PGlite();
const count = 30000;
const runs = 24;
const age = `CASE WHEN m.date_of_birth IS NULL THEN NULL
  WHEN EXTRACT(YEAR FROM age(m.date_of_birth)) < 30 THEN 'Under 30'
  WHEN EXTRACT(YEAR FROM age(m.date_of_birth)) < 40 THEN '30-39'
  WHEN EXTRACT(YEAR FROM age(m.date_of_birth)) < 50 THEN '40-49'
  WHEN EXTRACT(YEAR FROM age(m.date_of_birth)) < 60 THEN '50-59' ELSE '60+' END`;
const dimensions = [
  ['occupation', 'm.occupation', 12], ['city', 'm.city', 12], ['state', 'm.state', 8],
  ['gender', 'm.gender', 6], ['age', age, 8], ['qualification', 'm.qualification', 8], ['team', 'm.team', 12],
];
async function baselineDemographics(db) {
  return Object.fromEntries(await Promise.all(dimensions.map(async ([key, expr, limit]) => [key,
    (await db.query(`SELECT COALESCE(NULLIF(UPPER(TRIM(${expr})), ''), 'UNSPECIFIED') AS label,
      COUNT(*)::int AS count FROM members m WHERE ${CLIENT_DEMOGRAPHICS_SCOPE}
      GROUP BY 1 ORDER BY 2 DESC LIMIT $2`, [1, limit])).rows,
  ])));
}
const def = { from: 'events e', dateCol: 'e.date', amount: 'e.amount',
  columns: [{ key: 'id', expr: 'e.id' }, { key: 'amount', expr: 'e.amount' }] };
const options = { def, dimension: { expr: 'e.mode' }, bucket: 'day',
  where: "e.site_id = $1 AND e.date >= $2::date AND e.date < ($3::date + INTERVAL '1 day') AND e.status = 'approved'",
  params: [1, '2026-01-01', '2026-12-31'], rowLimit: 500 };
const number = value => Math.round(value * 100) / 100;
const percentile = (values, percent) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * percent) - 1] || 0;
async function measure(operation, concurrentRequests) {
  let queries = 0; let active = 0; let peakSubmittedQueries = 0;
  const queryTimes = []; const requestTimes = []; let bytes = 0;
  const tracked = { query: async (...args) => {
    queries++; active++; peakSubmittedQueries = Math.max(peakSubmittedQueries, active);
    const started = performance.now();
    try { return await db.query(...args); }
    finally { queryTimes.push(performance.now() - started); active--; }
  } };
  const started = performance.now();
  for (let offset = 0; offset < runs; offset += concurrentRequests) {
    await Promise.all(Array.from({ length: Math.min(concurrentRequests, runs - offset) }, async () => {
      const start = performance.now();
      const value = await operation(tracked);
      requestTimes.push(performance.now() - start);
      bytes += Buffer.byteLength(JSON.stringify(value));
    }));
  }
  const duration = performance.now() - started;
  return { requests: runs, queries, queries_per_request: queries / runs,
    request_latency_ms: { p50: number(percentile(requestTimes, .5)), p95: number(percentile(requestTimes, .95)), p99: number(percentile(requestTimes, .99)) },
    query_time_ms: { total_including_queue: number(queryTimes.reduce((a, b) => a + b, 0)), slowest_including_queue: number(Math.max(...queryTimes)) },
    throughput_requests_per_second: number(runs * 1000 / duration), errors: 0,
    peak_submitted_queries: peakSubmittedQueries, average_payload_bytes: Math.round(bytes / runs), duration_ms: number(duration) };
}
async function plan(sql, params) {
  const { rows } = await db.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`, params);
  const result = rows[0]['QUERY PLAN'][0];
  const scans = [];
  const walk = node => {
    if (node['Relation Name']) scans.push({ relation: node['Relation Name'], node: node['Node Type'], rows: node['Actual Rows'], loops: node['Actual Loops'], shared_hit_blocks: node['Shared Hit Blocks'] });
    (node.Plans || []).forEach(walk);
  };
  walk(result.Plan);
  return { execution_ms: number(result['Execution Time']), planning_ms: number(result['Planning Time']), scans };
}
try {
  await db.exec(`CREATE TABLE events(id int PRIMARY KEY, site_id int, date date, amount numeric, mode text, status text);
    INSERT INTO events SELECT n, 1 + n % 3, DATE '2026-01-01' + n % 360,
      CASE WHEN n % 7 = 0 THEN -123.45 ELSE 250.15 END,
      CASE WHEN n % 2 = 0 THEN 'CASH' ELSE 'BANK' END,
      CASE WHEN n % 17 = 0 THEN 'pending' ELSE 'approved' END FROM generate_series(1,${count}) n;
    CREATE TABLE members(id int PRIMARY KEY, site_id int, member_type text, status text,
      occupation text, city text, state text, gender text, date_of_birth date, qualification text, team text);
    INSERT INTO members SELECT n, 1 + n % 3,
      CASE WHEN n % 5 = 0 THEN 'AGENT' ELSE 'CLIENT' END, CASE WHEN n % 29 = 0 THEN 'deleted' ELSE 'active' END,
      'JOB' || n % 9, 'CITY' || n % 9, 'STATE' || n % 5, CASE WHEN n % 2 = 0 THEN 'Male' ELSE 'Female' END,
      CURRENT_DATE - (20 + n % 50) * INTERVAL '1 year', 'QUAL' || n % 5, 'TEAM' || n % 9 FROM generate_series(1,${count}) n;
    ANALYZE events; ANALYZE members;`);
  assert.deepEqual(normaliseReportRows(await loadReportRows(db, options)), normaliseReportRows(await baselineReportRows(db, options)));
  const sort = value => Object.fromEntries(Object.entries(value).map(([key, rows]) => [key, rows.sort((a, b) => a.label.localeCompare(b.label))]));
  assert.deepEqual(sort(await loadClientDemographics(1, db)), sort(await baselineDemographics(db)));
  const output = { generated_at: new Date().toISOString(), engine: 'PGlite 0.3.15 (isolated PostgreSQL WASM, one database execution worker)',
    fixture_rows_per_table: count, requests_per_case: runs, network_latency_ms: 0,
    caveat: 'Synthetic SQL benchmarks, not live API, browser, production pool, or multi-process PostgreSQL measurements. Query times include PGlite queue wait. Peak submitted queries are promises, not active connections.',
    cases: [], plans: {}, memory: {} };
  for (const [name, baseline, optimized] of [
    ['report', q => baselineReportRows(q, options), q => loadReportRows(q, options)],
    ['client_demographics', q => baselineDemographics(q), q => loadClientDemographics(1, q)],
  ]) {
    for (let warm = 0; warm < 3; warm++) { await baseline(db); await optimized(db); }
    for (const concurrency of [1, 6]) output.cases.push({ workload: name, simultaneous_requests: concurrency,
      baseline: await measure(baseline, concurrency), optimized: await measure(optimized, concurrency) });
  }
  const queries = reportReadQueries(def, options.dimension, options.bucket, options.where);
  output.plans.report_summary = await plan(queries.summary, options.params);
  output.plans.client_demographics = await plan(CLIENT_DEMOGRAPHICS_SQL, [1]);
  const memory = process.memoryUsage();
  output.memory = { heap_used_mb: number(memory.heapUsed / 1048576), rss_mb: number(memory.rss / 1048576), note: 'Combined fixture engine and benchmark process, not application memory.' };
  process.stdout.write(JSON.stringify(output, null, 2) + '\n');
} finally { await db.close(); }
