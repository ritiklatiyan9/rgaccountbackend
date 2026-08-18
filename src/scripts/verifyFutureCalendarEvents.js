import 'dotenv/config';
import { google } from 'googleapis';
import pool from '../config/db.js';
import { decrypt } from '../utils/tokenCrypto.js';
import { buildOAuthClient, SOURCES, syncComplianceEvent } from '../services/googleCalendarSync.service.js';
import { getEventPreferences } from '../services/eventReminder.service.js';

const repair = process.argv.includes('--repair');

const remoteStatus = (error) => error?.code ?? error?.response?.status;

async function run() {
  const { rows: connections } = await pool.query(
    `SELECT organization_id,access_token_enc,refresh_token_enc,token_expiry
       FROM google_calendar_connections WHERE status='active'`,
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
        WHERE organization_id=$1 AND google_event_id IS NOT NULL ORDER BY event_type,source_id`,
      [connection.organization_id],
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
      let operation = 'verified';
      if (repair) {
        const result = await syncComplianceEvent(connection.organization_id, link.event_type, link.source_id);
        operation = result?.operation || result?.status?.toLowerCase() || 'verified';
      }
      const currentLink = (await pool.query(
        `SELECT * FROM google_calendar_event_links WHERE organization_id=$1 AND event_type=$2 AND source_id=$3`,
        [connection.organization_id, link.event_type, link.source_id],
      )).rows[0];
      let remote;
      try {
        remote = (await calendar.events.get({ calendarId: 'primary', eventId: currentLink.google_event_id })).data;
      } catch (error) {
        report.push({ eventType: link.event_type, sourceId: link.source_id, mapping: true, remoteExists: false, error: remoteStatus(error) });
        continue;
      }
      const preferences = await getEventPreferences({
        ...source, id: link.source_id, event_type: link.event_type, timed: config.timed,
        event_at: source[config.dateField], organization_id: connection.organization_id,
      });
      const erpKey = `${connection.organization_id}:${link.event_type}:${link.source_id}`;
      const duplicates = await calendar.events.list({
        calendarId: 'primary', privateExtendedProperty: `erpEventKey=${erpKey}`,
        maxResults: 10, showDeleted: false, singleEvents: true,
      });
      const remindersOk = remote.reminders?.useDefault === false
        && (config.timed
          ? remote.reminders?.overrides?.some((item) => item.method === 'popup' && item.minutes === 30)
          : (remote.reminders?.overrides || []).length === 0);
      report.push({
        eventType: link.event_type,
        sourceId: link.source_id,
        googleEventId: currentLink.google_event_id,
        operation,
        mapping: true,
        remoteExists: true,
        remindersOk,
        timezoneOk: config.timed ? remote.start?.timeZone === preferences.timezone : true,
        startPresent: Boolean(remote.start?.date || remote.start?.dateTime),
        endPresent: Boolean(remote.end?.date || remote.end?.dateTime),
        keyedRemoteCount: duplicates.data.items?.length || 0,
        noKeyedDuplicate: (duplicates.data.items?.length || 0) === 1,
      });
    }
  }
  console.log(JSON.stringify({ repair, checked: report.length, events: report }, null, 2));
  if (report.some((item) => !item.mapping || !item.remoteExists || !item.remindersOk || !item.timezoneOk || !item.noKeyedDuplicate)) {
    process.exitCode = 2;
  }
}

run().catch((error) => {
  console.error('Calendar verification failed:', error.message);
  process.exitCode = 1;
}).finally(() => pool.end());

