import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { buildEventBody, SOURCES } from '../src/services/googleCalendarSync.service.js';
import { complianceEventInstant } from '../src/services/complianceEventTime.service.js';

const source = readFileSync(new URL('../src/scripts/verifyFutureCalendarEvents.js', import.meta.url), 'utf8')
  .replace(/^import[\s\S]*?;\n/gm, '').replace(/\nrun\(\)\.catch[\s\S]*$/, '');

const verification = ({ args = ['--organization-id=1'], linked = true, unmapped = false } = {}) => {
  const logs = [], queries = [];
  const row = { id: 8, organization_id: 1, title: 'Timed review', current_due_date: '2040-10-13', metadata: { event_time: '14:30' } };
  const body = buildEventBody('COMPLIANCE', row, [], { timeZone: 'Asia/Kolkata', erpEventKey: '1:COMPLIANCE:8' });
  const mapping = { event_type: 'COMPLIANCE', source_id: 8, google_event_id: linked ? 'remote-8' : null };
  let remoteReads = 0;
  const context = { process: { argv: ['node', 'verify', ...args] }, console: { log: value => logs.push(JSON.parse(value)) },
    pool: { async query(sql, params) {
      queries.push({ sql, params });
      if (sql.includes('FROM google_calendar_connections')) return { rows: [{ id: 1, organization_id: 1 }] };
      if (sql.includes('FROM google_calendar_event_links')) return { rows: unmapped ? [] : [mapping] };
      if (sql.includes('FROM compliance_items')) return { rows: [row] };
      if (/FROM (legal_cases|legal_notices|compliance_inspections|compliance_licences)/.test(sql)) return { rows: [] };
      throw new Error(`Unexpected SQL: ${sql}`);
    } },
    buildOAuthClient: () => ({ setCredentials() {} }), decrypt: () => 'test', SOURCES, buildEventBody, complianceEventInstant,
    getEventPreferences: async () => ({ timezone: 'Asia/Kolkata', calendar_enabled: true }),
    google: { calendar: () => ({ events: {
      async get() { remoteReads++; return { data: body }; },
      async list() { return { data: { items: [{ id: 'remote-8' }] } }; },
    } }) },
  };
  vm.createContext(context);
  vm.runInContext(`${source}\nthis.verify=run;`, context);
  return { context, logs, queries, remoteReads: () => remoteReads };
};

test('verification uses compliance metadata time when checking native alerts and timezone', async () => {
  const harness = verification();
  await harness.context.verify();
  const event = harness.logs[0].events[0];
  assert.equal(event.remindersOk, true);
  assert.equal(event.timezoneOk, true);
  assert.equal(event.dateOk, true);
  assert.equal(event.ownershipOk, true);
  assert.equal(event.endOk, true);
  assert.equal(event.noAttendees, true);
  assert.equal(event.noKeyedDuplicate, true);
  assert.equal(harness.context.process.exitCode, undefined);
  assert.deepEqual(Array.from(harness.queries[0].params), [1]);
});

test('verification reports a failed mapping with no Google event ID instead of ignoring it', async () => {
  const harness = verification({ linked: false });
  await harness.context.verify();
  assert.equal(harness.logs[0].checked, 1);
  assert.equal(harness.logs[0].events[0].mapping, false);
  assert.equal(harness.context.process.exitCode, 2);
  assert.equal(harness.remoteReads(), 0);
});

test('repair refuses unscoped organization changes before making any queries', async () => {
  const harness = verification({ args: ['--repair'] });
  await assert.rejects(harness.context.verify(), /requires --organization-id/);
  assert.equal(harness.queries.length, 0);
});

test('verification includes future source dates even when no mapping row was created', async () => {
  const harness = verification({ unmapped: true });
  await harness.context.verify();
  assert.equal(harness.logs[0].checked, 1);
  assert.equal(harness.logs[0].events[0].mapping, false);
  assert.equal(harness.context.process.exitCode, 2);
});
