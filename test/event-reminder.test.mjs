import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateReminderSchedule, deterministicMessageId, eventLocalDate,
  normalizeEmail, zonedDateTimeToUtc,
} from '../src/services/eventReminder.service.js';
import { buildEventBody } from '../src/services/googleCalendarSync.service.js';

test('all-day events schedule day-before and event-day only in the tenant timezone', () => {
  const event = { timed: false, event_at: '2026-08-23' };
  const schedule = calculateReminderSchedule(event, 'Asia/Kolkata');
  assert.deepEqual(schedule.map((item) => item.reminderType), ['DAY_BEFORE', 'EVENT_DAY']);
  assert.equal(schedule[0].scheduledAt.toISOString(), '2026-08-22T03:30:00.000Z');
  assert.equal(schedule[1].scheduledAt.toISOString(), '2026-08-23T03:30:00.000Z');
});

test('database DATE objects retain their local calendar day instead of UTC serialization day', () => {
  const localMidnight = new Date(2026, 7, 23, 0, 0, 0);
  assert.equal(eventLocalDate({ timed: false, event_at: localMidnight }, 'Asia/Kolkata'), '2026-08-23');
});

test('timed events add an exact 30-minute reminder', () => {
  const event = { timed: true, event_at: '2026-08-23T06:00:00.000Z' }; // 11:30 IST
  const schedule = calculateReminderSchedule(event, 'Asia/Kolkata');
  const thirty = schedule.find((item) => item.reminderType === 'THIRTY_MINUTES_BEFORE');
  assert.equal(thirty.scheduledAt.toISOString(), '2026-08-23T05:30:00.000Z');
  assert.equal(eventLocalDate(event, 'Asia/Kolkata'), '2026-08-23');
});

test('midnight events retain their local business date', () => {
  const instant = zonedDateTimeToUtc('2026-08-23', '00:00:00', 'Asia/Kolkata');
  assert.equal(instant.toISOString(), '2026-08-22T18:30:00.000Z');
  assert.equal(eventLocalDate({ timed: true, event_at: instant }, 'Asia/Kolkata'), '2026-08-23');
});

test('recipient email normalization rejects malformed input', () => {
  assert.equal(normalizeEmail(' Accounts@Example.COM '), 'accounts@example.com');
  assert.equal(normalizeEmail('not-an-email'), null);
});

test('Google timed events use event-level native popup overrides', () => {
  const body = buildEventBody('INSPECTION', {
    inspection_type: 'Registry appointment', scheduled_at: '2026-08-23T06:00:00.000Z',
  }, [], { timeZone: 'Asia/Kolkata', erpEventKey: '1:INSPECTION:3' });
  assert.deepEqual(body.reminders, { useDefault: false, overrides: [{ method: 'popup', minutes: 30 }] });
  assert.equal(body.extendedProperties.private.erpEventKey, '1:INSPECTION:3');
  assert.equal(body.start.timeZone, 'Asia/Kolkata');
});

test('Google all-day events never receive a 30-minute override', () => {
  const body = buildEventBody('COMPLIANCE', { title: 'Filing', current_due_date: '2026-08-23' });
  assert.deepEqual(body.reminders, { useDefault: false, overrides: [] });
  assert.deepEqual(body.start, { date: '2026-08-23' });
  assert.deepEqual(body.end, { date: '2026-08-24' });
});

test('email Message-ID is stable per reminder recipient and changes across recipients', () => {
  const base = {
    organization_id: 1, event_type: 'INSPECTION', source_id: 3,
    reminder_type: 'EVENT_DAY', scheduled_at: '2026-08-23T03:30:00.000Z',
  };
  assert.equal(
    deterministicMessageId({ ...base, recipient_key: 'email:a@example.com' }),
    deterministicMessageId({ ...base, recipient_key: 'email:a@example.com' }),
  );
  assert.notEqual(
    deterministicMessageId({ ...base, recipient_key: 'email:a@example.com' }),
    deterministicMessageId({ ...base, recipient_key: 'email:b@example.com' }),
  );
});
