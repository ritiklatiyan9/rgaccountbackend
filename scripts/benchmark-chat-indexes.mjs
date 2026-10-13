// This creates/drops indexes only inside an isolated PostgreSQL WASM database.
// It never connects to the configured application database.
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import Conversation from '../src/models/Conversation.model.js';

const db = new PGlite();
const migration = readFileSync(new URL('../src/migrations/review/205_chat_read_indexes.sql', import.meta.url), 'utf8');
const rollback = readFileSync(new URL('../src/migrations/review/205_chat_read_indexes.rollback.sql', import.meta.url), 'utf8');
const fixtureRows = 40000, runs = 24;
const round = value => Math.round(value * 100) / 100;
const quantile = (values, q) => round([...values].sort((a, b) => a - b)[Math.ceil(values.length * q) - 1]);
async function measure(sql, params) {
  const times = [];
  for (let warm = 0; warm < 3; warm++) await db.query(sql, params);
  for (let run = 0; run < runs; run++) {
    const start = performance.now(); await db.query(sql, params); times.push(performance.now() - start);
  }
  return { p50: quantile(times, .5), p95: quantile(times, .95), p99: quantile(times, .99) };
}
async function explain(sql, params) {
  const { rows } = await db.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`, params);
  const result = rows[0]['QUERY PLAN'][0], scans = [];
  const walk = node => {
    if (node['Relation Name'] === 'messages' || node['Index Name']?.startsWith('idx_messages_')) {
      scans.push({ node: node['Node Type'], relation: node['Relation Name'], index: node['Index Name'],
        rows: node['Actual Rows'], loops: node['Actual Loops'],
        filtered: node['Rows Removed by Filter'], sharedHitBlocks: node['Shared Hit Blocks'] });
    }
    (node.Plans || []).forEach(walk);
  };
  walk(result.Plan);
  return { planningMs: round(result['Planning Time']), executionMs: round(result['Execution Time']), scans };
}
try {
  await db.exec(`CREATE TABLE users(id int PRIMARY KEY, name text, photo text, organization_id int);
    CREATE TABLE conversations(id int PRIMARY KEY, user1_id int, user2_id int, site_id int, created_at timestamp);
    CREATE TABLE messages(id int PRIMARY KEY, conversation_id int, sender_id int, message_text text, created_at timestamp, is_read boolean);
    INSERT INTO users SELECT n,'User '||n,NULL,CASE WHEN n=30 THEN 2 ELSE 1 END FROM generate_series(1,30) n;
    INSERT INTO conversations SELECT n,1,n+1,1,TIMESTAMP '2026-01-01' + n * INTERVAL '1 day' FROM generate_series(1,20) n;
    INSERT INTO conversations VALUES(21,1,22,NULL,'2026-02-01'),(22,1,23,2,'2026-02-01'),(23,1,30,1,'2026-02-01');
    INSERT INTO messages SELECT n,1+(n%20),CASE WHEN n%2=0 THEN 1 ELSE 2 END,'Message '||n,
      TIMESTAMP '2026-01-01' + n * INTERVAL '1 minute',n%3=0 FROM generate_series(1,${fixtureRows}) n;
    ANALYZE users; ANALYZE conversations; ANALYZE messages;`);
  let sql, params;
  const beforeRows = await Conversation.getUserConversations(1, 1, {
    query(query, values) { sql = query; params = values; return db.query(query, values); },
  });
  const before = { latencyMs: await measure(sql, params), plan: await explain(sql, params) };
  // CONCURRENTLY is a deployment lock-management concern, not supported by
  // this in-memory single-worker fixture. Index expressions are unchanged.
  await db.exec(migration.replace(/\bCONCURRENTLY\b/g, ''));
  await db.exec('ANALYZE messages');
  assert.deepEqual((await db.query(sql, params)).rows, beforeRows);
  const after = { latencyMs: await measure(sql, params), plan: await explain(sql, params) };
  assert.equal(before.plan.scans.filter(scan => scan.node === 'Seq Scan').length, 2);
  assert.equal(after.plan.scans.filter(scan => scan.node === 'Seq Scan').length, 0);
  assert.ok(after.plan.scans.some(scan => scan.index === 'idx_messages_conversation_created'));
  assert.ok(after.plan.scans.some(scan => scan.index === 'idx_messages_conversation_unread_sender'));
  await db.exec(rollback.replace(/\bCONCURRENTLY\b/g, ''));
  assert.deepEqual((await db.query(sql, params)).rows, beforeRows);
  console.log(JSON.stringify({ generatedAt: new Date().toISOString(), engine: 'PGlite 0.3.15',
    scope: 'Isolated SQL/plan fixture. Review migration NOT applied to application DB.',
    fixtureRows, visibleConversations: beforeRows.length, runs, before, after,
    resultEquivalence: true, rollbackVerified: true }, null, 2));
} finally { await db.close(); }
