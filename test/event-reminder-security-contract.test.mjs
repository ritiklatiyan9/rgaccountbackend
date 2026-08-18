import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

test('reminder ledger enforces recipient-level idempotency and indexed due claims', async () => {
  const migration = await read('../src/migrations/095_event_reminder_engine.js');
  assert.match(migration, /UNIQUE \(organization_id, event_type, source_id, reminder_type, channel, scheduled_at, recipient_key\)/);
  assert.match(migration, /idx_event_reminders_due/);
  assert.match(migration, /organization_id INTEGER NOT NULL/);
  assert.match(migration, /site_id INTEGER REFERENCES sites/);
});

test('worker is multi-instance safe, recovers abandoned claims, and bounds retries', async () => {
  const worker = await read('../src/services/eventReminderScheduler.service.js');
  assert.match(worker, /FOR UPDATE SKIP LOCKED/);
  assert.match(worker, /status='PROCESSING' AND last_attempt_at < NOW\(\)-INTERVAL '15 minutes'/);
  assert.match(worker, /attempt_count < 3/);
  assert.match(worker, /row\.attempt_count <= 1 \? 5 : 15/);
  assert.match(worker, /status='PROCESSING'/);
});

test('event APIs enforce module permission and assigned-site boundaries', async () => {
  const controller = await read('../src/controllers/eventReminder.controller.js');
  assert.match(controller, /permission\?\.\[`can_\$\{action\}`\] !== true/);
  assert.match(controller, /user_sites WHERE user_id=\$1 AND site_id=\$2/);
  assert.match(controller, /req\.user\.organization_id/);
  assert.match(controller, /One or more assigned users are outside this event site|scopedEvent/);
});

test('all event mutation paths invoke both Google and reminder reconciliation', async () => {
  const controller = await read('../src/controllers/compliance.controller.js');
  assert.match(controller, /queueGoogleCalendarSync/);
  assert.match(controller, /queueReminderReconciliation/);
  assert.match(controller, /RESCHEDULE_APPROVED/);
  assert.match(controller, /deleteComplianceEntity/);
});

test('Google sync updates canonical mappings and searches ERP metadata before insert', async () => {
  const google = await read('../src/services/googleCalendarSync.service.js');
  const disconnect = await read('../src/controllers/googleCalendar.controller.js');
  assert.match(google, /erpEventKey/);
  assert.match(google, /privateExtendedProperty/);
  assert.match(google, /events\.update/);
  assert.match(google, /events\.insert/);
  assert.doesNotMatch(disconnect, /DELETE FROM google_calendar_event_links/);
});

