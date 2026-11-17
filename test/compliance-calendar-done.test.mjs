import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../src/controllers/compliance.controller.js', import.meta.url), 'utf8');
const start = source.indexOf('export const withDoneTicks');
const body = source.slice(start, source.indexOf('\n};', start) + 3).replace('export const ', 'const ');

test('calendar ticks match on event type + id, including BIGINT ids returned as strings', () => {
  const context = vm.createContext({});
  vm.runInContext(`${body};globalThis.merge=withDoneTicks;`, context);
  const events = [{ event_type: 'COMPLIANCE', id: 12 }, { event_type: 'LEGAL_HEARING', id: 12 }];
  const [compliance, hearing] = context.merge(events, [{ event_type: 'COMPLIANCE', source_id: '12', done_at: 'T', done_by_name: 'Asha' }]);
  assert.equal(compliance.done, true);
  assert.equal(compliance.done_by_name, 'Asha');
  assert.equal(hearing.done, false, 'same id on another event type stays unticked');
});
