import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

test('a migration or recovered connection restores reads without restarting the server', async () => {
  const source = readFileSync(new URL('../src/utils/schemaProbe.js', import.meta.url), 'utf8')
    .replace(/^import .*;\n/m, '').replace(/export /g, '');
  for (const failedConnection of [false, true]) {
    let calls = 0, resolve;
    const context = vm.createContext({ pool: { query: () => {
      calls++;
      if (calls === 1 && failedConnection) return Promise.reject(new Error('Connection interrupted'));
      return new Promise(done => { resolve = done; });
    } } });
    vm.runInContext(`${source}\nthis.probe = hasRelation;`, context);
    const first = context.probe('plot_status_approvals');
    const concurrent = context.probe('plot_status_approvals');
    assert.equal(calls, 1, 'concurrent header and full-page reads share one probe');
    if (!failedConnection) resolve({ rows: [{ present: false }] });
    assert.equal(await first, false);
    assert.equal(await concurrent, false);
    const afterMigration = context.probe('plot_status_approvals');
    assert.equal(calls, 2);
    resolve({ rows: [{ present: true }] });
    assert.equal(await afterMigration, true);
    assert.equal(await context.probe('plot_status_approvals'), true);
    assert.equal(calls, 2, 'available schema objects stay cached');
  }
});

test('batch schema probes share one query with concurrent single probes and retry missing objects', async () => {
  const source = readFileSync(new URL('../src/utils/schemaProbe.js', import.meta.url), 'utf8')
    .replace(/^import .*;\n/m, '').replace(/export /g, '');
  let calls = 0, finish;
  const context = vm.createContext({ pool: { query() {
    calls++;
    return new Promise(resolve => { finish = resolve; });
  } } });
  vm.runInContext(`${source}\nthis.batch=hasRelations;this.single=hasRelation;`, context);
  const batch = context.batch(['expenses', 'seek_permissions', 'expenses']);
  const concurrent = context.single('expenses');
  assert.equal(calls, 1);
  finish({ rows: [{ name: 'expenses', present: true }, { name: 'seek_permissions', present: false }] });
  assert.equal((await batch).get('expenses'), true);
  assert.equal(await concurrent, true);
  const retry = context.batch(['expenses', 'seek_permissions']);
  assert.equal(calls, 2);
  finish({ rows: [{ name: 'seek_permissions', present: true }] });
  assert.equal((await retry).get('seek_permissions'), true);
  assert.equal(await context.single('expenses'), true);
  assert.equal(calls, 2);
});
