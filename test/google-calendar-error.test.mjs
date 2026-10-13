import test from 'node:test';
import assert from 'node:assert/strict';
import { calendarSyncError } from '../src/services/googleCalendarError.service.js';

test('disabled API errors lead to the affected project instead of asking for a reconnect', () => {
  const detail = calendarSyncError(new Error('Google Calendar API has not been used in project 652880497016 before or it is disabled.'));
  assert.equal(detail.code, 'API_DISABLED');
  assert.equal(detail.setup_url, 'https://console.cloud.google.com/apis/library/calendar-json.googleapis.com?project=652880497016');
  assert.match(detail.message, /Enable it, then refresh future events/);
  assert.doesNotMatch(detail.message, /Reconnect/);
});

test('revoked tokens require reconnect while unknown errors do not expose provider contents', () => {
  assert.equal(calendarSyncError(new Error('invalid_grant')).code, 'RECONNECT_REQUIRED');
  assert.deepEqual(calendarSyncError(new Error('Unexpected provider response with private token')), {
    code: 'SYNC_FAILED', message: 'Google Calendar could not sync. Refresh future events to retry.',
  });
});
