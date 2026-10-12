import { google } from 'googleapis';
import pool from '../config/db.js';
import { complianceEventInstant } from './complianceEventTime.service.js';
import { encrypt, decrypt } from '../utils/tokenCrypto.js';
import { DEFAULT_TIME_ZONE, getEventPreferences, isValidTimeZone } from './eventReminder.service.js';

/**
 * Best-effort push of compliance events to the organization's connected
 * Google calendars. Each connected account has its own remote event mapping.
 * Events sync directly without attendees or invitation emails. Sync is never
 * allowed to fail the primary request —
 * call sites go through queueCalendarSync, which swallows and logs.
 */

const TIME_ZONE = DEFAULT_TIME_ZONE;

// Mirrors the union in compliance.controller complianceCalendar(): where each
// event type's title/date live, and whether the date carries a time of day.
export const SOURCES = Object.freeze({
  COMPLIANCE: { table: 'compliance_items', titleField: 'title', dateField: 'current_due_date', timed: false },
  LEGAL_HEARING: { table: 'legal_cases', titleField: 'title', dateField: 'next_hearing_date', timed: true },
  NOTICE_REPLY: { table: 'legal_notices', titleField: 'subject', dateField: 'reply_due_date', timed: false },
  INSPECTION: { table: 'compliance_inspections', titleField: 'inspection_type', dateField: 'scheduled_at', timed: true },
  LICENCE_EXPIRY: { table: 'compliance_licences', titleField: 'name', dateField: 'expiry_date', timed: false },
});

const EVENT_LABELS = Object.freeze({
  COMPLIANCE: 'Compliance deadline',
  LEGAL_HEARING: 'Legal hearing',
  NOTICE_REPLY: 'Notice reply due',
  INSPECTION: 'Inspection',
  LICENCE_EXPIRY: 'Licence expiry',
});

const isConfigured = () =>
  Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET
    && process.env.GOOGLE_REDIRECT_URI && process.env.CALENDAR_TOKEN_ENC_KEY);

export const buildOAuthClient = () => new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI,
);

const ymd = (value) => {
  const d = value instanceof Date ? value : new Date(value);
  const shifted = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return shifted.toISOString().slice(0, 10);
};

const nextDay = (dateStr) => {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
};

/** Pure event-body builder — exercised directly by the sanity check script. */
export const buildEventBody = (eventType, row, _attendeeEmails = [], options = {}) => {
  const cfg = SOURCES[eventType];
  const label = EVENT_LABELS[eventType];
  const title = row[cfg.titleField] || label;
  const complianceInstant = eventType === 'COMPLIANCE' ? complianceEventInstant(row) : null;
  const dateValue = complianceInstant || row[cfg.dateField];
  const timed = cfg.timed || Boolean(complianceInstant);
  const descriptionLines = [
    label,
    row.status ? `Status: ${row.status}` : null,
    row.risk_level ? `Risk: ${row.risk_level}` : null,
    row.location ? `Location: ${row.location}` : null,
  ].filter(Boolean);

  let start;
  let end;
  if (timed) {
    const startDate = dateValue instanceof Date ? dateValue : new Date(dateValue);
    const endDate = new Date(startDate.getTime() + 60 * 60 * 1000); // 1h default duration
    const timeZone = isValidTimeZone(options.timeZone) ? options.timeZone : TIME_ZONE;
    start = { dateTime: startDate.toISOString(), timeZone };
    end = { dateTime: endDate.toISOString(), timeZone };
  } else {
    const dateStr = typeof dateValue === 'string' ? dateValue.slice(0, 10) : ymd(dateValue);
    start = { date: dateStr };
    end = { date: nextDay(dateStr) }; // Google all-day end date is exclusive
  }

  return {
    summary: title,
    description: descriptionLines.join('\n'),
    start,
    end,
    attendees: [],
    reminders: {
      useDefault: false,
      overrides: timed && options.nativeReminder !== false
        ? [{ method: 'popup', minutes: 30 }]
        : [],
    },
    extendedProperties: options.erpEventKey ? { private: { erpEventKey: options.erpEventKey } } : undefined,
  };
};

/** Authenticate one account without touching another connection. */
const orgCalendar = async (orgId, connectionId) => {
  if (!isConfigured()) return null;
  const { rows } = await pool.query(
    `SELECT id, access_token_enc, refresh_token_enc, token_expiry
       FROM google_calendar_connections
      WHERE organization_id=$1 AND id=$2 AND status='active' LIMIT 1`,
    [orgId, connectionId],
  );
  const connection = rows[0];
  if (!connection) return null;

  const auth = buildOAuthClient();
  auth.setCredentials({
    access_token: decrypt(connection.access_token_enc),
    refresh_token: decrypt(connection.refresh_token_enc),
    expiry_date: connection.token_expiry ? new Date(connection.token_expiry).getTime() : undefined,
  });
  auth.on('tokens', (tokens) => {
    if (!tokens.access_token) return;
    pool.query(
      `UPDATE google_calendar_connections
          SET access_token_enc=$1, token_expiry=$2, updated_at=NOW()
        WHERE id=$3`,
      [encrypt(tokens.access_token), tokens.expiry_date ? new Date(tokens.expiry_date) : null, connection.id],
    ).catch((err) => console.error('[gcal] failed to persist refreshed token:', err.message));
  });
  return {
    calendar: google.calendar({ version: 'v3', auth }),
    connectionId: connection.id,
  };
};

const deleteLinkedEvent = async (calendar, orgId, connectionId, eventType, sourceId, sendUpdates = 'none') => {
  const { rows } = await pool.query(
    `SELECT id, google_event_id FROM google_calendar_event_links
      WHERE organization_id=$1 AND event_type=$2 AND source_id=$3 AND connection_id=$4 LIMIT 1`,
    [orgId, eventType, sourceId, connectionId],
  );
  if (!rows[0]) return;
  if (rows[0].google_event_id) {
    try {
      await calendar.events.delete({ calendarId: 'primary', eventId: rows[0].google_event_id, sendUpdates });
    } catch (err) {
      if (![404, 410].includes(err?.code ?? err?.response?.status)) throw err;
    }
  }
  await pool.query('DELETE FROM google_calendar_event_links WHERE id=$1', [rows[0].id]);
};

const writeSyncAudit = (organizationId, siteId, eventType, sourceId, action, metadata = {}, reason = null) => pool.query(
  `INSERT INTO compliance_audit_log
    (organization_id,site_id,action,entity_type,entity_id,new_value,reason)
   VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7)`,
  [organizationId, siteId || null, action, eventType, sourceId, JSON.stringify(metadata), reason],
).catch((error) => console.error('[gcal] audit write failed:', error.message));

/**
 * Reconcile one internal event with Google Calendar: upsert while the source
 * row is live and dated, cancel when it is deleted or loses its date.
 */
const syncConnectionEvent = async (orgId, eventType, sourceId, connectionId) => {
  const cfg = SOURCES[eventType];
  if (!cfg) throw new Error(`Unknown calendar event type: ${eventType}`);
  const lockClient = await pool.connect();
  const lockKey = `gcal:${orgId}:${connectionId}:${eventType}:${sourceId}`;
  await lockClient.query('SELECT pg_advisory_lock(hashtext($1))', [lockKey]);
  try {
    const connection = await orgCalendar(orgId, connectionId);
    if (!connection) return { status: 'DISCONNECTED' };
    const { calendar } = connection;
    const sendUpdates = 'none';

    const { rows } = await pool.query(
    `SELECT * FROM ${cfg.table} WHERE id=$1 AND organization_id=$2 LIMIT 1`,
    [sourceId, orgId],
  );
    const row = rows[0];
    if (!row || row.deleted_at || !row[cfg.dateField]) {
      await deleteLinkedEvent(calendar, orgId, connectionId, eventType, sourceId, sendUpdates);
      await writeSyncAudit(orgId, row?.site_id, eventType, sourceId, 'GOOGLE_CALENDAR_EVENT_DELETED');
      return { status: 'DELETED' };
    }

    const eventFacade = {
      ...row, event_type: eventType, event_at: row[cfg.dateField], timed: cfg.timed,
      organization_id: orgId,
    };
    const preferences = await getEventPreferences(eventFacade);
    if (preferences.calendar_enabled === false) {
      await deleteLinkedEvent(calendar, orgId, connectionId, eventType, sourceId, sendUpdates);
      await writeSyncAudit(orgId, row.site_id, eventType, sourceId, 'GOOGLE_CALENDAR_DISABLED');
      return { status: 'DISABLED' };
    }

    const erpEventKey = `${orgId}:${eventType}:${sourceId}`;
    const body = buildEventBody(eventType, row, [], {
      timeZone: preferences.timezone,
      nativeReminder: true,
      erpEventKey,
    });

    const { rows: linkRows } = await pool.query(
    `SELECT id, google_event_id FROM google_calendar_event_links
      WHERE organization_id=$1 AND event_type=$2 AND source_id=$3 AND connection_id=$4 LIMIT 1`,
    [orgId, eventType, sourceId, connectionId],
  );
    let link = linkRows[0];
    await pool.query(
      `INSERT INTO google_calendar_event_links
        (organization_id,event_type,source_id,connection_id,google_event_id,sync_status,last_attempt_at,sync_attempt_count)
       VALUES ($1,$2,$3,$4,NULL,'PROCESSING',NOW(),1)
       ON CONFLICT (connection_id,event_type,source_id) DO UPDATE SET
         sync_status='PROCESSING',last_attempt_at=NOW(),sync_attempt_count=google_calendar_event_links.sync_attempt_count+1,
         failure_reason=NULL,updated_at=NOW()`,
      [orgId, eventType, sourceId, connectionId],
    );

    if (link?.google_event_id) {
    try {
      const { data } = await calendar.events.update({
        calendarId: 'primary', eventId: link.google_event_id, requestBody: body, sendUpdates,
      });
      await pool.query(
        `UPDATE google_calendar_event_links SET sync_status='SYNCED',last_synced_at=NOW(),
          failure_reason=NULL,google_html_link=$2,remote_updated_at=$3,updated_at=NOW() WHERE id=$1`,
        [link.id, data.htmlLink || null, data.updated ? new Date(data.updated) : null],
      );
      await writeSyncAudit(orgId, row.site_id, eventType, sourceId, 'GOOGLE_CALENDAR_SYNCED', { connectionId, operation: 'updated', googleEventId: link.google_event_id });
      console.log(`[gcal] updated ${eventType}#${sourceId} (org ${orgId}) → ${link.google_event_id}`);
      return { status: 'SYNCED', googleEventId: link.google_event_id, operation: 'updated' };
    } catch (err) {
      if (![404, 410].includes(err?.code ?? err?.response?.status)) throw err;
      await pool.query(
        `UPDATE google_calendar_event_links SET google_event_id=NULL,sync_status='PENDING',updated_at=NOW() WHERE id=$1`,
        [link.id],
      );
      link = { ...link, google_event_id: null };
    }
  }

    // Recover a remote event whose local mapping was lost before creating a new
    // one. The private ERP key is stable and not visible in the event UI.
    const matches = await calendar.events.list({
      calendarId: 'primary', privateExtendedProperty: `erpEventKey=${erpEventKey}`,
      maxResults: 2, singleEvents: true, showDeleted: false,
    });
    const recovered = matches.data.items?.[0];
    if (recovered?.id) {
      const { data } = await calendar.events.update({
        calendarId: 'primary', eventId: recovered.id, requestBody: body, sendUpdates,
      });
      await pool.query(
        `UPDATE google_calendar_event_links SET google_event_id=$1,sync_status='SYNCED',last_synced_at=NOW(),
          failure_reason=NULL,google_html_link=$2,remote_updated_at=$3,updated_at=NOW()
         WHERE organization_id=$4 AND event_type=$5 AND source_id=$6 AND connection_id=$7`,
        [data.id, data.htmlLink || null, data.updated ? new Date(data.updated) : null, orgId, eventType, sourceId, connectionId],
      );
      await writeSyncAudit(orgId, row.site_id, eventType, sourceId, 'GOOGLE_CALENDAR_SYNCED', { connectionId, operation: 'recovered', googleEventId: data.id });
      return { status: 'SYNCED', googleEventId: data.id, operation: 'recovered' };
    }

    // Legacy events created before ERP metadata was added can still be safely
    // recovered by an exact summary + start + end match. Ambiguity fails closed
    // for manual review instead of creating a possible duplicate.
    const expectedStart = body.start.date || body.start.dateTime;
    const expectedEnd = body.end.date || body.end.dateTime;
    const windowStart = body.start.date
      ? new Date(`${body.start.date}T00:00:00.000Z`)
      : new Date(new Date(body.start.dateTime).getTime() - 60_000);
    const windowEnd = body.end.date
      ? new Date(`${body.end.date}T23:59:59.999Z`)
      : new Date(new Date(body.end.dateTime).getTime() + 60_000);
    const legacyCandidates = await calendar.events.list({
      calendarId: 'primary', q: body.summary, timeMin: windowStart.toISOString(),
      timeMax: windowEnd.toISOString(), maxResults: 20, singleEvents: true, showDeleted: false,
    });
    const exactLegacy = (legacyCandidates.data.items || []).filter((item) => {
      const remoteStart = item.start?.date || item.start?.dateTime;
      const remoteEnd = item.end?.date || item.end?.dateTime;
      const sameStart = body.start.date ? remoteStart === expectedStart
        : new Date(remoteStart).getTime() === new Date(expectedStart).getTime();
      const sameEnd = body.end.date ? remoteEnd === expectedEnd
        : new Date(remoteEnd).getTime() === new Date(expectedEnd).getTime();
      return item.summary === body.summary && sameStart && sameEnd;
    });
    if (exactLegacy.length > 1) {
      throw new Error('Multiple legacy Google events match this ERP event; manual duplicate review is required');
    }
    if (exactLegacy[0]?.id) {
      const { data } = await calendar.events.update({
        calendarId: 'primary', eventId: exactLegacy[0].id, requestBody: body, sendUpdates,
      });
      await pool.query(
        `UPDATE google_calendar_event_links SET google_event_id=$1,sync_status='SYNCED',last_synced_at=NOW(),
          failure_reason=NULL,google_html_link=$2,remote_updated_at=$3,updated_at=NOW()
         WHERE organization_id=$4 AND event_type=$5 AND source_id=$6 AND connection_id=$7`,
        [data.id, data.htmlLink || null, data.updated ? new Date(data.updated) : null, orgId, eventType, sourceId, connectionId],
      );
      await writeSyncAudit(orgId, row.site_id, eventType, sourceId, 'GOOGLE_CALENDAR_SYNCED', { connectionId, operation: 'legacy_recovered', googleEventId: data.id });
      return { status: 'SYNCED', googleEventId: data.id, operation: 'legacy_recovered' };
    }

    const { data } = await calendar.events.insert({
      calendarId: 'primary', requestBody: body, sendUpdates,
    });
    await pool.query(
      `UPDATE google_calendar_event_links SET google_event_id=$1,sync_status='SYNCED',last_synced_at=NOW(),
        failure_reason=NULL,google_html_link=$2,remote_updated_at=$3,updated_at=NOW()
       WHERE organization_id=$4 AND event_type=$5 AND source_id=$6 AND connection_id=$7`,
      [data.id, data.htmlLink || null, data.updated ? new Date(data.updated) : null, orgId, eventType, sourceId, connectionId],
    );
    await writeSyncAudit(orgId, row.site_id, eventType, sourceId, 'GOOGLE_CALENDAR_SYNCED', { connectionId, operation: 'created', googleEventId: data.id });
    console.log(`[gcal] created ${eventType}#${sourceId} (org ${orgId}) → ${data.id}`);
    return { status: 'SYNCED', googleEventId: data.id, operation: 'created' };
  } catch (error) {
    await pool.query(
      `UPDATE google_calendar_event_links SET sync_status='FAILED',failure_reason=$1,updated_at=NOW()
        WHERE organization_id=$2 AND event_type=$3 AND source_id=$4 AND connection_id=$5`,
      [String(error.message || error).slice(0, 2000), orgId, eventType, sourceId, connectionId],
    ).catch(() => {});
    await writeSyncAudit(orgId, null, eventType, sourceId, 'GOOGLE_CALENDAR_SYNC_FAILED', { connectionId }, String(error.message || error).slice(0, 2000));
    if (String(error.message || '').includes('invalid_grant')) {
      await pool.query(
        `UPDATE google_calendar_connections SET status='reauthorization_required',updated_at=NOW() WHERE organization_id=$1 AND id=$2`,
        [orgId, connectionId],
      ).catch(() => {});
    }
    throw error;
  } finally {
    await lockClient.query('SELECT pg_advisory_unlock(hashtext($1))', [lockKey]).catch(() => {});
    lockClient.release();
  }
};

/** Sync each active account independently so one failed token cannot stop
 * the other calendars. A supplied connection id targets one account. */
export const syncComplianceEvent = async (orgId, eventType, sourceId, connectionId = null) => {
  if (!SOURCES[eventType]) throw new Error(`Unknown calendar event type: ${eventType}`);
  if (!isConfigured()) return { status: 'DISCONNECTED', accounts: [] };
  const { rows } = await pool.query(`SELECT id,status FROM google_calendar_connections
    WHERE organization_id=$1 AND status IN ('active','reauthorization_required') AND ($2::bigint IS NULL OR id=$2) ORDER BY id`, [orgId, connectionId]);
  if (!rows.length) return { status: 'DISCONNECTED', accounts: [] };
  const accounts = [];
  for (const account of rows) {
    if (account.status === 'reauthorization_required') { accounts.push({ connectionId: account.id, status: 'FAILED', error: 'Reconnect this Google account in Calendar settings' }); continue; }
    try { accounts.push({ connectionId: account.id, ...await syncConnectionEvent(orgId, eventType, sourceId, account.id) }); }
    catch (error) { accounts.push({ connectionId: account.id, status: 'FAILED', error: error.message }); }
  }
  const first = accounts.find(account => account.status === 'SYNCED') || accounts[0];
  const status = accounts.some(account => account.status === 'FAILED') ? 'FAILED' : first.status;
  return { ...first, status, accounts };
};

/** Fire-and-forget hook for controllers — never throws into the request path. */
export const queueCalendarSync = (orgId, eventType, sourceId) => {
  syncComplianceEvent(orgId, eventType, sourceId).then(result => {
    if (result.status === 'FAILED') console.error(`[gcal] some accounts could not sync ${eventType}#${sourceId} (org ${orgId})`);
  }).catch((err) => {
    console.error(`[gcal] sync ${eventType}#${sourceId} (org ${orgId}) failed:`, err.message);
  });
};

/**
 * Push every future-dated live event to the connected calendar. Runs after a
 * successful connect so existing records appear without waiting to be edited.
 * Sequential on purpose — one org's backfill stays far below API rate limits.
 */
export const backfillOrgEvents = async (orgId, connectionId = null) => {
  let synced = 0, failed = 0;
  for (const [eventType, cfg] of Object.entries(SOURCES)) {
    const { rows } = await pool.query(
      `SELECT id FROM ${cfg.table}
        WHERE organization_id=$1 AND deleted_at IS NULL AND ${cfg.dateField} >= CURRENT_DATE`,
      [orgId],
    );
    for (const row of rows) {
      try {
        const result = await syncComplianceEvent(orgId, eventType, row.id, connectionId);
        synced += result.accounts.filter(account => account.status === 'SYNCED').length;
        failed += result.accounts.filter(account => account.status === 'FAILED').length;
      } catch (err) {
        failed += 1;
        console.error(`[gcal] backfill ${eventType}#${row.id} (org ${orgId}) failed:`, err.message);
      }
    }
  }
  console.log(`[gcal] backfill complete for org ${orgId}: ${synced} events synced`);
  return { synced, failed };
};
