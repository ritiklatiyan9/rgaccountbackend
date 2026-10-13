import 'dotenv/config';
import { google } from 'googleapis';
import pool from '../config/db.js';
import { decrypt } from '../utils/tokenCrypto.js';
import { buildEventBody, buildOAuthClient, SOURCES, syncComplianceEvent } from '../services/googleCalendarSync.service.js';
import { complianceEventInstant } from '../services/complianceEventTime.service.js';
import { getEventPreferences } from '../services/eventReminder.service.js';

const repair = process.argv.includes('--repair');
const organizationArg = process.argv.find(arg => arg.startsWith('--organization-id='));
const organizationId = organizationArg ? Number(organizationArg.split('=')[1]) : null;

const remoteStatus = (error) => error?.code ?? error?.response?.status;

async function run() {
  if ((organizationArg && (!Number.isSafeInteger(organizationId) || organizationId <= 0)) || (repair && !organizationId)) {
    throw new Error('Calendar repair requires --organization-id=<positive ID> to target one organization');
  }
  const { rows: connections } = await pool.query(
    `SELECT id,google_account_email,organization_id,access_token_enc,refresh_token_enc,token_expiry
       FROM google_calendar_connections WHERE status='active' AND ($1::int IS NULL OR organization_id=$1)`,
    [organizationId],
  );
  const report = [];
  for (const connection of connections) {
    const auth = buildOAuthClient();
    auth.setCredentials({
      access_token: decrypt(connection.access_token_enc),
      refresh_token: decrypt(connection.refresh_token_enc),
      expiry_date: connection.token_expiry ? new Date(connection.token_expiry).getTime() : undefined,
    });
    const calendar = google.calendar({ version: 'v3', auth });
    const { rows: links } = await pool.query(
      `SELECT * FROM google_calendar_event_links
        WHERE organization_id=$1 AND connection_id=$2 ORDER BY event_type,source_id`,
      [connection.organization_id, connection.id],
    );
    for (const link of links) {
      const config = SOURCES[link.event_type];
      if (!config) continue;
      const { rows } = await pool.query(
        `SELECT * FROM ${config.table} WHERE organization_id=$1 AND id=$2 AND deleted_at IS NULL AND ${config.dateField} >= CURRENT_DATE`,
        [connection.organization_id, link.source_id],
      );
      const source = rows[0];
      if (!source) continue;
      const instant = link.event_type === 'COMPLIANCE' ? complianceEventInstant(source) : null;
      const preferences = await getEventPreferences({
        ...source, id: link.source_id, event_type: link.event_type, timed: config.timed || Boolean(instant),
        event_at: instant || source[config.dateField], organization_id: connection.organization_id,
      });
      if (preferences.calendar_enabled === false) continue;
      let operation = 'verified';
      if (repair) {
        const result = await syncComplianceEvent(connection.organization_id, link.event_type, link.source_id, connection.id);
        operation = result?.operation || result?.status?.toLowerCase() || 'verified';
      }
      const currentLink = (await pool.query(
        `SELECT * FROM google_calendar_event_links WHERE organization_id=$1 AND event_type=$2 AND source_id=$3 AND connection_id=$4`,
        [connection.organization_id, link.event_type, link.source_id, connection.id],
      )).rows[0];
      if (!currentLink?.google_event_id) {
        report.push({ connectionId: connection.id, eventType: link.event_type, sourceId: link.source_id, mapping: false, remoteExists: false });
        continue;
      }
      let remote;
      try {
        remote = (await calendar.events.get({ calendarId: 'primary', eventId: currentLink.google_event_id })).data;
      } catch (error) {
        report.push({ connectionId: connection.id, eventType: link.event_type, sourceId: link.source_id, mapping: true, remoteExists: false, error: remoteStatus(error) });
        continue;
      }
      const expected = buildEventBody(link.event_type, source, [], { timeZone: preferences.timezone });
      const erpKey = `${connection.organization_id}:${link.event_type}:${link.source_id}`;
      const duplicates = await calendar.events.list({
        calendarId: 'primary', privateExtendedProperty: `erpEventKey=${erpKey}`,
        maxResults: 10, showDeleted: false, singleEvents: true,
      });
      const overrides = remote.reminders?.overrides || [];
      const remindersOk = remote.reminders?.useDefault === false
        && overrides.length === expected.reminders.overrides.length
        && expected.reminders.overrides.every(wanted => overrides.some(item => item.method === wanted.method && item.minutes === wanted.minutes));
      report.push({
        connectionId: connection.id,
        eventType: link.event_type,
        sourceId: link.source_id,
        googleEventId: currentLink.google_event_id,
        operation,
        mapping: true,
        remoteExists: true,
        remindersOk,
        timezoneOk: expected.start.dateTime ? remote.start?.timeZone === expected.start.timeZone : true,
        dateOk: expected.start.date ? remote.start?.date === expected.start.date
          : new Date(remote.start?.dateTime).getTime() === new Date(expected.start.dateTime).getTime(),
        startPresent: Boolean(remote.start?.date || remote.start?.dateTime),
        endPresent: Boolean(remote.end?.date || remote.end?.dateTime),
        keyedRemoteCount: duplicates.data.items?.length || 0,
        noKeyedDuplicate: (duplicates.data.items?.length || 0) === 1,
      });
    }
  }
  console.log(JSON.stringify({ repair, organizationId, checked: report.length, events: report }, null, 2));
  if (report.some((item) => !item.mapping || !item.remoteExists || !item.remindersOk || !item.timezoneOk || !item.dateOk || !item.noKeyedDuplicate)) {
    process.exitCode = 2;
  }
}

run().catch((error) => {
  console.error('Calendar verification failed:', error.message);
  process.exitCode = 1;
}).finally(() => pool.end());

