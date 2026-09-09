import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const read = (relativePath) => readFileSync(new URL(relativePath, import.meta.url), 'utf8');

// Migrations 158 (plot_status_approvals) and 160 (plot_money_transfers) are not
// applied on every database this backend serves. A read path that names either
// object without probing for it first answers 42P01 — which surfaced as a 500 on
// /approvals/pending and as "Plot not found" on every plot detail page.
const GUARDED = [
  ['plot_money_transfers', '160'],
  ['plot_status_approvals', '158'],
];

test('every read path naming an unrun migration object probes for it first', () => {
  const sources = {
    'controllers/plot.controller.js': read('../src/controllers/plot.controller.js'),
    'controllers/approval.controller.js': read('../src/controllers/approval.controller.js'),
    'services/plotMoneyTransfer.service.js': read('../src/services/plotMoneyTransfer.service.js'),
  };
  for (const [file, source] of Object.entries(sources)) {
    for (const [relation, migration] of GUARDED) {
      if (!source.includes(relation)) continue;
      assert.match(source, new RegExp(`hasRelation\\('${relation}'\\)`),
        `${file} queries ${relation} (migration ${migration}) but never probes with hasRelation`);
    }
  }
});

test('the payments list falls back to a literal so a plot still loads', () => {
  const source = read('../src/controllers/plot.controller.js');
  assert.match(source, /hasRelation\('plot_money_transfers'\)\s*\n?\s*\?[\s\S]{0,220}?:\s*'0::numeric'/,
    'money_transferred_amount must fall back to 0 rather than a subquery on a missing table');
  assert.ok(source.indexOf("const transferred = await hasRelation('plot_money_transfers')")
    < source.indexOf('${transferred} AS money_transferred_amount'),
    'the probe must resolve before the query string is built');
});

test('approvals report zero pending plot-status rows instead of failing', () => {
  const source = read('../src/controllers/approval.controller.js');
  assert.match(source, /rows: \[\{ count: 0 \}\]/, 'the counts endpoint needs a zero fallback');
  assert.match(source, /module === 'plot_status'\) && visPlot\.include && await hasRelation\('plot_status_approvals'\)/,
    'the pending list must skip the plot-status source when the view is absent');
});

test('a transfer attempt fails with a message, not a raw database error', () => {
  const source = read('../src/services/plotMoneyTransfer.service.js');
  assert.match(source, /if \(!await hasRelation\('plot_money_transfers'\)\) fail\(503, /);
  assert.ok(source.indexOf("hasRelation('plot_money_transfers')") < source.indexOf('pg_advisory_xact_lock'),
    'the guard must run before any work is done');
});

test('the probe caches the promise so concurrent callers issue one query', () => {
  const source = read('../src/utils/schemaProbe.js');
  assert.match(source, /probes\.set\(name, pool\s*\n?\s*\.query\(/, 'cache the promise, not the resolved value');
  assert.match(source, /\.catch\(\(\) => false\)/, 'a failed probe must not reject the caller');
  assert.match(source, /to_regclass\(\$1\)/, 'the relation name must be a bound parameter');
});
