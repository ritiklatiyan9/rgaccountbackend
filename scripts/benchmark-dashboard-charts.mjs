import { PGlite } from '@electric-sql/pglite';
import { performance } from 'node:perf_hooks';
import assert from 'node:assert/strict';
import pool from '../src/config/db.js';
import { getRevenueVsExpense } from '../src/graphql/services/charts.service.js';
import { dashboardChartBaselineSql } from '../test/support/dashboard-chart-baseline.mjs';
import { createDashboardChartFixture } from '../test/support/dashboard-chart-fixture.mjs';

// Capture the real chart SQL without opening the configured application DB.
let optimizedSql;
let params;
const originalQuery = pool.query;
pool.query = async (sql, values) => { optimizedSql = sql; params = values; return { rows: [] }; };
try { await getRevenueVsExpense(1, '2000-01-01', '2100-01-01', 'YEAR'); }
finally { pool.query = originalQuery; }
const baselineSql = dashboardChartBaselineSql(optimizedSql);
const db = new PGlite();
const fixtureRows = 30000;
const samples = 48;
const round = n => Math.round(n * 100) / 100;
const percentile = (values, p) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1];
const latencies = { baseline: [], optimized: [] };
async function measure(label, sql) {
  const started = performance.now();
  await db.query(sql, params);
  latencies[label].push(performance.now() - started);
}
async function explain(sql) {
  const { rows } = await db.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`, params);
  const result = rows[0]['QUERY PLAN'][0];
  const scans = [];
  const walk = node => {
    if (node['Relation Name']) scans.push({ relation: node['Relation Name'], type: node['Node Type'],
      rows: node['Actual Rows'], loops: node['Actual Loops'], shared_hit_blocks: node['Shared Hit Blocks'] });
    (node.Plans || []).forEach(walk);
  };
  walk(result.Plan);
  return { planning_ms: round(result['Planning Time']), execution_ms: round(result['Execution Time']), scans };
}
try {
  await createDashboardChartFixture(db, fixtureRows);
  const before = (await db.query(baselineSql, params)).rows;
  const after = (await db.query(optimizedSql, params)).rows;
  assert.deepEqual(after, before);
  for (let i = 0; i < 3; i++) { await db.query(baselineSql, params); await db.query(optimizedSql, params); }
  // Alternate order to reduce the effect of engine warm-up and run ordering.
  for (let i = 0; i < samples; i++) {
    if (i % 2) { await measure('optimized', optimizedSql); await measure('baseline', baselineSql); }
    else { await measure('baseline', baselineSql); await measure('optimized', optimizedSql); }
  }
  const summary = values => ({ samples: values.length, p50_ms: round(percentile(values, .5)),
    p95_ms: round(percentile(values, .95)), minimum_ms: round(Math.min(...values)), maximum_ms: round(Math.max(...values)) });
  const memory = process.memoryUsage();
  const output = {
    generated_at: new Date().toISOString(), engine: 'PGlite 0.3.15 (isolated PostgreSQL WASM)',
    fixture: { source_tables: 8, rows_per_source: fixtureRows, sites: 3, ledger_rows: fixtureRows,
      table_rows_total: fixtureRows * 12, network_latency_ms: 0, concurrent_queries: 1 },
    cache: '3 warm-up executions per variant; application cache bypassed; alternating baseline/optimized order',
    caveat: 'Synthetic SQL latency and plan comparison, not production API latency. The ledger is a fixture table, not the application view. PGlite uses one execution worker. No configured application database connection or migration is used.',
    baseline: summary(latencies.baseline), optimized: summary(latencies.optimized),
    identical_chart_rows: after.length, payload_bytes: Buffer.byteLength(JSON.stringify(after)),
    plans: { baseline: await explain(baselineSql), optimized: await explain(optimizedSql) },
    memory: { heap_used_mb: round(memory.heapUsed / 1048576), rss_mb: round(memory.rss / 1048576),
      note: 'Fixture database plus benchmark process, not server memory.' },
  };
  process.stdout.write(JSON.stringify(output, null, 2) + '\n');
} finally { await db.close(); await pool.end(); }
