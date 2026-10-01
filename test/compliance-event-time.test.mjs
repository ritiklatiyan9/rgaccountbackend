import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeOptionalEventTime, complianceEventInstant } from '../src/services/complianceEventTime.service.js';
import { loadEventSource } from '../src/services/eventSource.service.js';
import { buildEventBody } from '../src/services/googleCalendarSync.service.js';
import { calculateReminderSchedule } from '../src/services/eventReminder.service.js';

test('optional time accepts blank and midnight and rejects invalid clock values', () => {
  assert.equal(normalizeOptionalEventTime(''), null);
  assert.equal(normalizeOptionalEventTime(null), null);
  assert.equal(normalizeOptionalEventTime('00:00'), '00:00');
  assert.equal(normalizeOptionalEventTime('23:59'), '23:59');
  for (const invalid of ['24:00', '12:60', '9:30', 'tomorrow']) {
    assert.throws(() => normalizeOptionalEventTime(invalid), { statusCode: 400 });
  }
});

test('time uses the Indian business date for strings and database DATE objects', () => {
  for (const date of ['2026-10-01', new Date(2026, 9, 1)]) {
    assert.equal(complianceEventInstant({ current_due_date: date, metadata: { event_time: '00:00' } }).toISOString(), '2026-09-30T18:30:00.000Z');
  }
  assert.equal(complianceEventInstant({ current_due_date: '2026-10-01' }), null);
});

test('saved compliance time drives Google Calendar and exact reminder scheduling', async () => {
  const row = { id: 1, title: 'Filing', current_due_date: '2026-10-01', metadata: { event_time: '14:30' } };
  const event = await loadEventSource(1, 'COMPLIANCE', 1, { query: async () => ({ rows: [row] }) });
  assert.equal(event.timed, true);
  assert.equal(event.event_at.toISOString(), '2026-10-01T09:00:00.000Z');
  const thirty = calculateReminderSchedule(event).find((item) => item.reminderType === 'THIRTY_MINUTES_BEFORE');
  assert.equal(thirty.scheduledAt.toISOString(), '2026-10-01T08:30:00.000Z');
  const body = buildEventBody('COMPLIANCE', row);
  assert.equal(body.start.dateTime, '2026-10-01T09:00:00.000Z');
  assert.equal(body.end.dateTime, '2026-10-01T10:00:00.000Z');
});

test('blank time retains all-day calendar and reminder behavior', async () => {
  const row = { id: 1, title: 'Filing', current_due_date: '2026-10-01', metadata: { event_time: null } };
  const event = await loadEventSource(1, 'COMPLIANCE', 1, { query: async () => ({ rows: [row] }) });
  assert.equal(event.timed, false);
  assert.deepEqual(buildEventBody('COMPLIANCE', row).start, { date: '2026-10-01' });
  assert.equal(calculateReminderSchedule(event).length, 2);
});
