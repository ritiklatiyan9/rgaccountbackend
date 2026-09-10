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
