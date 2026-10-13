import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { getMemberLinks } from '../src/services/memberLinks.service.js';

// Reuse the accounting/identity fixture from its regression test. This is an
// isolated database; neither implementation sees application credentials.
const testSource = readFileSync(new URL('../test/member-links.test.mjs', import.meta.url), 'utf8');
const fixtureSql = testSource.match(/await db\.exec\(`([\s\S]*?)`\);/)?.[1];
assert.ok(fixtureSql, 'member identity fixture must exist');
const baselineRef = process.argv[2];
assert.ok(baselineRef, 'Usage: node scripts/benchmark-member-link-concurrency.mjs <baseline-git-ref>');
let source = execFileSync('git', ['show', `${baselineRef}:src/services/memberLinks.service.js`], { encoding: 'utf8' });
source = source.replace(/from (['"])(\.\.?\/[^'"]+)\1/g, (_, quote, relative) =>
  `from ${quote}${new URL(relative, new URL('../src/services/memberLinks.service.js', import.meta.url)).href}${quote}`);
const { getMemberLinks: baseline } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const db = new PGlite();
const args = { memberId: 1, allSites: true, user: { role: 'admin', organization_id: 1 } };
async function measure(operation) {
  let active = 0, peak = 0, queries = 0, plotScans = 0;
  const database = { async query(sql, params) {
    queries += 1; active += 1; peak = Math.max(peak, active);
    if (sql.includes('AS broker_member_ids')) plotScans += 1;
    try { return await db.query(sql, params); } finally { active -= 1; }
  } };
  const start = performance.now(); const result = await operation(database, args);
  return { queries, peakSubmittedQueries: peak, plotScans, latencyMs: Math.round((performance.now() - start) * 100) / 100, result };
}
try {
  await db.exec(fixtureSql);
  await db.exec("UPDATE members SET shared_profile_id='00000000-0000-0000-0000-000000000001' WHERE id=4");
  // Warm both implementations before comparing scheduling; PGlite has one
  // execution worker, so peakSubmittedQueries is NOT active DB connections.
  await baseline(db, args); await getMemberLinks(db, args);
  const before = await measure(baseline), after = await measure(getMemberLinks);
  assert.deepEqual(after.result, before.result);
  delete before.result; delete after.result;
  console.log(JSON.stringify({ generatedAt: new Date().toISOString(), baselineRef,
    engine: 'PGlite 0.3.15', scope: 'Isolated identity fixture; three registrations in two sites',
    caveat: 'Peak submitted query promises, not active PostgreSQL connections or production latency.',
    before, after, resultEquivalence: true }, null, 2));
} finally { await db.close(); }
