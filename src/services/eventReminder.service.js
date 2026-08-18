import crypto from 'crypto';
import pool from '../config/db.js';
import { EVENT_SOURCES, loadEventSource, normalizeEventType } from './eventSource.service.js';

export const DEFAULT_TIME_ZONE = 'Asia/Kolkata';
export const REMINDER_TYPES = Object.freeze(['DAY_BEFORE', 'EVENT_DAY', 'THIRTY_MINUTES_BEFORE']);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_RECIPIENTS = 50;

export const isValidTimeZone = (value) => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
};

const formatParts = (instant, timeZone) => Object.fromEntries(
  new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(instant).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]),
);

export const zonedDateTimeToUtc = (date, time, timeZone = DEFAULT_TIME_ZONE) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}(?::\d{2})?$/.test(time)) {
    throw new Error('Invalid local date/time');
  }
  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute, second = 0] = time.split(':').map(Number);
  const desired = Date.UTC(year, month - 1, day, hour, minute, second);
  let candidate = desired;
  for (let pass = 0; pass < 3; pass += 1) {
    const actual = formatParts(new Date(candidate), timeZone);
    const represented = Date.UTC(
      Number(actual.year), Number(actual.month) - 1, Number(actual.day),
      Number(actual.hour), Number(actual.minute), Number(actual.second),
    );
    candidate += desired - represented;
  }
  return new Date(candidate);
};

const dateOnly = (value) => {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10);
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    // node-postgres materializes DATE as local midnight. UTC serialization can
    // therefore show the previous day on an IST host; retain its calendar fields.
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
  }
  return null;
};

const shiftDate = (ymd, days) => {
  const date = new Date(`${ymd}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};

export const eventLocalDate = (event, timeZone) => {
  if (!event.timed) return dateOnly(event.event_at);
  const parts = formatParts(new Date(event.event_at), timeZone);
  return `${parts.year}-${parts.month}-${parts.day}`;
};

export const calculateReminderSchedule = (event, timeZone = DEFAULT_TIME_ZONE) => {
  const localDate = eventLocalDate(event, timeZone);
  if (!localDate) return [];
  const dayBefore = zonedDateTimeToUtc(shiftDate(localDate, -1), '09:00:00', timeZone);
  let eventDay = zonedDateTimeToUtc(localDate, '09:00:00', timeZone);
  const result = [{ reminderType: 'DAY_BEFORE', scheduledAt: dayBefore }];
  if (event.timed) {
    const eventStart = new Date(event.event_at);
    const localStart = formatParts(eventStart, timeZone);
    if (Number(localStart.hour) < 9) eventDay = zonedDateTimeToUtc(localDate, '00:00:00', timeZone);
    result.push({ reminderType: 'EVENT_DAY', scheduledAt: eventDay });
    result.push({ reminderType: 'THIRTY_MINUTES_BEFORE', scheduledAt: new Date(eventStart.getTime() - 30 * 60 * 1000) });
  } else {
    result.push({ reminderType: 'EVENT_DAY', scheduledAt: eventDay });
  }
  return result;
};

export const normalizeEmail = (value) => {
  const email = String(value || '').trim().toLowerCase();
  return email.length <= 255 && EMAIL_RE.test(email) ? email : null;
};

export const defaultPreferences = (event, timeZone = DEFAULT_TIME_ZONE) => ({
  organization_id: event.organization_id,
  site_id: event.site_id || null,
  event_type: event.event_type,
  source_id: event.id,
  timezone: timeZone,
  email_day_before: true,
  email_event_day: true,
  email_thirty_minutes: event.timed,
  calendar_enabled: true,
  fcm_enabled: false,
  assigned_user_ids: [],
  additional_emails: [],
});

export async function getEventPreferences(event, db = pool) {
  const { rows } = await db.query(
    `SELECT p.* FROM event_reminder_preferences p
      WHERE p.organization_id=$1 AND p.event_type=$2 AND p.source_id=$3 LIMIT 1`,
    [event.organization_id, event.event_type, event.id],
  );
  if (rows[0]) return rows[0];
  const tz = await db.query(
    `SELECT COALESCE(timezone,$2) AS timezone FROM compliance_settings WHERE organization_id=$1`,
    [event.organization_id, DEFAULT_TIME_ZONE],
  );
  return defaultPreferences(event, tz.rows[0]?.timezone || DEFAULT_TIME_ZONE);
}

export async function resolveEventReminderRecipients(event, preferences, db = pool) {
  const explicitIds = Array.isArray(preferences.assigned_user_ids) ? preferences.assigned_user_ids.map(Number) : [];
  const userIds = [...new Set([...event.owner_user_ids, ...explicitIds].filter(Number.isSafeInteger))].slice(0, MAX_RECIPIENTS);
  const users = userIds.length ? await db.query(
    `SELECT u.id,u.name,LOWER(BTRIM(u.email)) AS email
       FROM users u
      WHERE u.organization_id=$1 AND u.is_active=TRUE AND u.id=ANY($2::int[])
        AND ($3::int IS NULL OR u.role IN ('admin','super_admin') OR EXISTS (
          SELECT 1 FROM user_sites us WHERE us.user_id=u.id AND us.site_id=$3
        ))`,
    [event.organization_id, userIds, event.site_id || null],
  ) : { rows: [] };
  const configured = await db.query(
    `SELECT LOWER(BTRIM(email)) AS email FROM google_calendar_notify_emails
      WHERE organization_id=$1 ORDER BY email LIMIT $2`,
    [event.organization_id, MAX_RECIPIENTS],
  );
  const byEmail = new Map();
  for (const user of users.rows) {
    const email = normalizeEmail(user.email);
    if (email) byEmail.set(email, { email, name: user.name, userId: user.id });
  }
  const externalEmails = [...(preferences.additional_emails || []), ...configured.rows.map((row) => row.email)];
  for (const candidate of externalEmails) {
    const email = normalizeEmail(candidate);
    if (email && !byEmail.has(email)) byEmail.set(email, { email, name: null, userId: null });
  }
  return [...byEmail.values()].slice(0, MAX_RECIPIENTS);
}

const typeEnabled = (preferences, reminderType) => ({
  DAY_BEFORE: preferences.email_day_before,
  EVENT_DAY: preferences.email_event_day,
  THIRTY_MINUTES_BEFORE: preferences.email_thirty_minutes,
}[reminderType] === true);

export function usefulUntil(event, reminderType, timeZone) {
  const localDate = eventLocalDate(event, timeZone);
  if (!localDate) return new Date(0);
  if (reminderType === 'DAY_BEFORE') return zonedDateTimeToUtc(localDate, '00:00:00', timeZone);
  if (event.timed) return new Date(event.event_at);
  return zonedDateTimeToUtc(shiftDate(localDate, 1), '00:00:00', timeZone);
}

const snapshotFor = (event, preferences, recipients) => ({
  title: String(event.title || 'Calendar event').slice(0, 300),
  description: String(event.description || '').slice(0, 5000),
  location: String(event.location || '').slice(0, 500),
  siteName: event.site_name || null,
  eventAt: event.timed ? event.event_at : eventLocalDate(event, preferences.timezone),
  timed: event.timed,
  timezone: preferences.timezone,
  actionPath: event.action_path,
  assignedNames: recipients.filter((recipient) => recipient.userId).map((recipient) => recipient.name).filter(Boolean),
});

export async function reconcileEventReminders(organizationId, eventType, sourceId, { actorUserId = null, db = pool } = {}) {
  const type = normalizeEventType(eventType);
  if (!type) throw new Error('Unsupported calendar event type');
  const event = await loadEventSource(organizationId, type, sourceId, db);
  if (!event) return { scheduled: 0, cancelled: 0, missing: true };
  const preferences = await getEventPreferences(event, db);
  const timeZone = isValidTimeZone(preferences.timezone) ? preferences.timezone : DEFAULT_TIME_ZONE;
  const recipients = await resolveEventReminderRecipients(event, preferences, db);
  const schedule = calculateReminderSchedule(event, timeZone);
  const now = new Date();
  const client = db === pool ? await pool.connect() : db;
  const ownsClient = db === pool;
  try {
    if (ownsClient) await client.query('BEGIN');
    if (event.cancelled || !event.event_at) {
      const cancelled = await client.query(
        `UPDATE event_reminders SET status='CANCELLED',updated_at=NOW(),failure_reason='Event cancelled or removed'
          WHERE organization_id=$1 AND event_type=$2 AND source_id=$3
            AND (status IN ('PENDING','FAILED') OR (status='PROCESSING' AND last_attempt_at < NOW()-INTERVAL '15 minutes'))`,
        [organizationId, type, sourceId],
      );
      if (ownsClient) await client.query('COMMIT');
      return { scheduled: 0, cancelled: cancelled.rowCount };
    }
    let scheduled = 0;
    const desiredIds = [];
    const snapshot = snapshotFor(event, { ...preferences, timezone: timeZone }, recipients);
    for (const item of schedule) {
      if (!typeEnabled(preferences, item.reminderType)) continue;
      const deadline = usefulUntil(event, item.reminderType, timeZone);
      if (deadline <= now) continue;
      const deliverAt = item.scheduledAt < now ? now : item.scheduledAt;
      for (const recipient of recipients) {
        const inserted = await client.query(
          `INSERT INTO event_reminders
            (organization_id,site_id,event_type,source_id,reminder_type,channel,scheduled_at,
             next_attempt_at,recipient_key,recipient_user_id,recipient_email,recipient_name,event_snapshot)
           VALUES ($1,$2,$3,$4,$5,'EMAIL',$6,$7,$8,$9,$10,$11,$12::jsonb)
           ON CONFLICT (organization_id,event_type,source_id,reminder_type,channel,scheduled_at,recipient_key)
           DO UPDATE SET recipient_user_id=EXCLUDED.recipient_user_id,recipient_name=EXCLUDED.recipient_name,
             event_snapshot=EXCLUDED.event_snapshot,updated_at=NOW()
           RETURNING id,(xmax=0) AS inserted`,
          [organizationId, event.site_id || null, type, sourceId, item.reminderType, item.scheduledAt, deliverAt,
            `email:${recipient.email}`, recipient.userId, recipient.email, recipient.name, JSON.stringify(snapshot)],
        );
        if (inserted.rows[0]?.id) {
          desiredIds.push(inserted.rows[0].id);
          if (inserted.rows[0].inserted) scheduled += 1;
        }
        if (preferences.fcm_enabled && recipient.userId) {
          const fcmInserted = await client.query(
            `INSERT INTO event_reminders
              (organization_id,site_id,event_type,source_id,reminder_type,channel,scheduled_at,
               next_attempt_at,recipient_key,recipient_user_id,recipient_name,event_snapshot)
             VALUES ($1,$2,$3,$4,$5,'FCM',$6,$7,$8,$9,$10,$11::jsonb)
             ON CONFLICT (organization_id,event_type,source_id,reminder_type,channel,scheduled_at,recipient_key)
             DO UPDATE SET event_snapshot=EXCLUDED.event_snapshot,updated_at=NOW()
             RETURNING id,(xmax=0) AS inserted`,
            [organizationId, event.site_id || null, type, sourceId, item.reminderType, item.scheduledAt, deliverAt,
              `user:${recipient.userId}`, recipient.userId, recipient.name, JSON.stringify(snapshot)],
          );
          if (fcmInserted.rows[0]?.id) {
            desiredIds.push(fcmInserted.rows[0].id);
            if (fcmInserted.rows[0].inserted) scheduled += 1;
          }
        }
      }
    }
    const cancelled = await client.query(
      `UPDATE event_reminders SET status='CANCELLED',updated_at=NOW(),failure_reason='Reminder schedule recalculated'
        WHERE organization_id=$1 AND event_type=$2 AND source_id=$3
          AND (status IN ('PENDING','FAILED') OR (status='PROCESSING' AND last_attempt_at < NOW()-INTERVAL '15 minutes'))
          AND NOT (id=ANY($4::bigint[]))`,
      [organizationId, type, sourceId, desiredIds],
    );
    if (scheduled || cancelled.rowCount) {
      await client.query(
        `INSERT INTO compliance_audit_log
          (organization_id,site_id,user_id,action,entity_type,entity_id,new_value)
         VALUES ($1,$2,$3,'REMINDER_SCHEDULE_UPDATED',$4,$5,$6::jsonb)`,
        [organizationId, event.site_id || null, actorUserId, type, sourceId,
          JSON.stringify({ scheduled, cancelled: cancelled.rowCount, recipients: recipients.length })],
      );
    }
    if (ownsClient) await client.query('COMMIT');
    return { scheduled, cancelled: cancelled.rowCount, recipients: recipients.length };
  } catch (error) {
    if (ownsClient) await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    if (ownsClient) client.release();
  }
}

export const queueReminderReconciliation = (organizationId, eventType, sourceId, actorUserId = null) => {
  reconcileEventReminders(organizationId, eventType, sourceId, { actorUserId }).catch((error) => {
    console.error(`[reminders] reconcile ${eventType}#${sourceId} (org ${organizationId}) failed:`, error.message);
  });
};

export async function saveEventPreferences(event, input, actorUserId, db = pool) {
  const timeZone = input.timezone || (await getEventPreferences(event, db)).timezone || DEFAULT_TIME_ZONE;
  if (!isValidTimeZone(timeZone)) throw Object.assign(new Error('Invalid IANA timezone'), { statusCode: 400 });
  const userIds = [...new Set((Array.isArray(input.assigned_user_ids) ? input.assigned_user_ids : [])
    .map(Number).filter(Number.isSafeInteger))].slice(0, MAX_RECIPIENTS);
  const emails = [...new Set((Array.isArray(input.additional_emails) ? input.additional_emails : [])
    .map(normalizeEmail).filter(Boolean))].slice(0, MAX_RECIPIENTS);
  if ((input.additional_emails || []).length !== emails.length) {
    throw Object.assign(new Error('Additional recipient emails must be valid and unique'), { statusCode: 400 });
  }
  if (userIds.length) {
    const valid = await db.query(
      `SELECT COUNT(*)::int AS count FROM users u
        WHERE u.organization_id=$1 AND u.is_active=TRUE AND u.id=ANY($2::int[])
          AND ($3::int IS NULL OR u.role IN ('admin','super_admin') OR EXISTS (
            SELECT 1 FROM user_sites us WHERE us.user_id=u.id AND us.site_id=$3
          ))`,
      [event.organization_id, userIds, event.site_id || null],
    );
    if (valid.rows[0].count !== userIds.length) throw Object.assign(new Error('One or more assigned users are outside this event site'), { statusCode: 400 });
  }
  const thirty = event.timed && input.email_thirty_minutes !== false;
  const { rows } = await db.query(
    `INSERT INTO event_reminder_preferences
      (organization_id,site_id,event_type,source_id,timezone,email_day_before,email_event_day,
       email_thirty_minutes,calendar_enabled,fcm_enabled,assigned_user_ids,additional_emails,created_by,updated_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13)
     ON CONFLICT (organization_id,event_type,source_id) DO UPDATE SET
       site_id=EXCLUDED.site_id,timezone=EXCLUDED.timezone,email_day_before=EXCLUDED.email_day_before,
       email_event_day=EXCLUDED.email_event_day,email_thirty_minutes=EXCLUDED.email_thirty_minutes,
       calendar_enabled=EXCLUDED.calendar_enabled,fcm_enabled=EXCLUDED.fcm_enabled,
       assigned_user_ids=EXCLUDED.assigned_user_ids,additional_emails=EXCLUDED.additional_emails,
       updated_by=EXCLUDED.updated_by,updated_at=NOW()
     RETURNING *`,
    [event.organization_id, event.site_id || null, event.event_type, event.id, timeZone,
      input.email_day_before !== false, input.email_event_day !== false, thirty,
      input.calendar_enabled !== false, input.fcm_enabled === true, userIds, emails, actorUserId],
  );
  return rows[0];
}

export const deterministicMessageId = (row) => {
  const digest = crypto.createHash('sha256').update([
    row.organization_id, row.event_type, row.source_id, row.reminder_type, row.scheduled_at, row.recipient_key,
  ].join(':')).digest('hex').slice(0, 32);
  return `<event-reminder-${digest}@dg-account.local>`;
};

export async function reconcileFutureEvents({ days = 370 } = {}) {
  const results = { events: 0, scheduled: 0, failed: 0 };
  const candidates = [];
  for (const [eventType, config] of Object.entries(EVENT_SOURCES)) {
    const interval = `${Math.max(1, Math.min(Number(days) || 370, 730))} days`;
    const { rows } = await pool.query(
      `SELECT id,organization_id FROM ${config.table}
        WHERE deleted_at IS NULL AND ${config.date} IS NOT NULL
          AND ${config.date} >= NOW()-INTERVAL '1 day'
          AND ${config.date} < NOW()+$1::interval`,
      [interval],
    );
    candidates.push(...rows.map((row) => ({ ...row, eventType })));
  }
  let cursor = 0;
  const concurrency = Math.min(8, Math.max(1, Number(process.env.EVENT_REMINDER_RECONCILE_CONCURRENCY) || 6));
  await Promise.all(Array.from({ length: Math.min(concurrency, candidates.length) }, async () => {
    while (cursor < candidates.length) {
      const row = candidates[cursor];
      cursor += 1;
      try {
        const outcome = await reconcileEventReminders(row.organization_id, row.eventType, row.id);
        results.events += 1;
        results.scheduled += outcome.scheduled;
      } catch (error) {
        results.failed += 1;
        console.error(`[reminders] startup reconcile ${row.eventType}#${row.id} failed:`, error.message);
      }
    }
  }));
  return results;
}
