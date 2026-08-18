import pool from '../config/db.js';
import asyncHandler from '../utils/asyncHandler.js';
import permissionModel from '../models/Permission.model.js';
import { isOrgAdmin, parsePositiveId } from '../utils/complianceAccess.js';
import { loadEventSource, normalizeEventType } from '../services/eventSource.service.js';
import {
  getEventPreferences, reconcileEventReminders, resolveEventReminderRecipients, saveEventPreferences,
} from '../services/eventReminder.service.js';
import { syncComplianceEvent } from '../services/googleCalendarSync.service.js';

const legalTypes = new Set(['LEGAL_HEARING', 'NOTICE_REPLY']);

async function scopedEvent(req, action = 'read') {
  const eventType = normalizeEventType(req.params.eventType);
  const sourceId = parsePositiveId(req.params.sourceId);
  if (!eventType || !sourceId) return null;
  const module = legalTypes.has(eventType) ? 'legal' : 'compliance';
  if (!isOrgAdmin(req.user)) {
    const permission = await permissionModel.getPermission(req.user.id, module);
    if (permission?.[`can_${action}`] !== true) return null;
  }
  const event = await loadEventSource(req.user.organization_id, eventType, sourceId);
  if (!event) return null;
  if (!isOrgAdmin(req.user) && (!event.site_id || !(await pool.query(
    `SELECT 1 FROM user_sites WHERE user_id=$1 AND site_id=$2 LIMIT 1`,
    [req.user.id, event.site_id],
  )).rowCount)) return null;
  return event;
}

export const getEventReminderState = asyncHandler(async (req, res) => {
  const event = await scopedEvent(req, 'read');
  if (!event) return res.status(404).json({ message: 'Calendar event not found or unavailable' });
  const [preferences, reminders, calendar] = await Promise.all([
    getEventPreferences(event),
    pool.query(
      `SELECT id,reminder_type,channel,scheduled_at,recipient_email,recipient_name,status,
              attempt_count,last_attempt_at,sent_at,provider_message_id,failure_reason,created_at,updated_at
         FROM event_reminders
        WHERE organization_id=$1 AND event_type=$2 AND source_id=$3
        ORDER BY scheduled_at,reminder_type,channel,recipient_key`,
      [event.organization_id, event.event_type, event.id],
    ),
    pool.query(
      `SELECT google_event_id,sync_status,last_synced_at,last_attempt_at,sync_attempt_count,
              failure_reason,google_html_link,remote_updated_at,updated_at
         FROM google_calendar_event_links
        WHERE organization_id=$1 AND event_type=$2 AND source_id=$3 LIMIT 1`,
      [event.organization_id, event.event_type, event.id],
    ),
  ]);
  const recipients = await resolveEventReminderRecipients(event, preferences);
  res.json({
    event: { id: event.id, event_type: event.event_type, timed: event.timed, cancelled: event.cancelled },
    preferences,
    recipients,
    reminders: reminders.rows,
    calendar: calendar.rows[0] || { sync_status: preferences.calendar_enabled ? 'PENDING' : 'DISABLED' },
  });
});

export const updateEventReminderState = asyncHandler(async (req, res) => {
  const event = await scopedEvent(req, 'update');
  if (!event) return res.status(404).json({ message: 'Calendar event not found or unavailable' });
  const preferences = await saveEventPreferences(event, req.body || {}, req.user.id);
  const result = await reconcileEventReminders(event.organization_id, event.event_type, event.id, { actorUserId: req.user.id });
  // Calendar delivery is isolated from the settings write and email schedule.
  syncComplianceEvent(event.organization_id, event.event_type, event.id).catch((error) => {
    console.error(`[gcal] reminder preference sync ${event.event_type}#${event.id} failed:`, error.message);
  });
  res.json({ preferences, reconciliation: result });
});

export const retryEventReminders = asyncHandler(async (req, res) => {
  const event = await scopedEvent(req, 'update');
  if (!event) return res.status(404).json({ message: 'Calendar event not found or unavailable' });
  const reminderId = parsePositiveId(req.body?.reminder_id);
  const params = [event.organization_id, event.event_type, event.id];
  let idScope = '';
  if (reminderId) { params.push(reminderId); idScope = ` AND id=$${params.length}`; }
  const { rowCount } = await pool.query(
    `UPDATE event_reminders SET status='PENDING',next_attempt_at=NOW(),failure_reason=NULL,updated_at=NOW()
      WHERE organization_id=$1 AND event_type=$2 AND source_id=$3 AND status='FAILED'
        AND attempt_count < 3 ${idScope}`,
    params,
  );
  res.json({ success: true, queued: rowCount });
});

export const retryEventCalendarSync = asyncHandler(async (req, res) => {
  const event = await scopedEvent(req, 'update');
  if (!event) return res.status(404).json({ message: 'Calendar event not found or unavailable' });
  await syncComplianceEvent(event.organization_id, event.event_type, event.id);
  res.json({ success: true });
});

export const registerPushToken = asyncHandler(async (req, res) => {
  const token = String(req.body?.token || '').trim();
  if (token.length < 40 || token.length > 4096) return res.status(400).json({ message: 'Invalid browser push token' });
  const { rows } = await pool.query(
    `INSERT INTO user_push_tokens (organization_id,user_id,token,user_agent)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (token) DO UPDATE SET organization_id=EXCLUDED.organization_id,user_id=EXCLUDED.user_id,
       user_agent=EXCLUDED.user_agent,last_seen_at=NOW()
     RETURNING id`,
    [req.user.organization_id, req.user.id, token, String(req.get('user-agent') || '').slice(0, 500)],
  );
  res.status(201).json({ success: true, id: rows[0].id });
});

export const removePushToken = asyncHandler(async (req, res) => {
  const token = String(req.body?.token || '').trim();
  const { rowCount } = await pool.query(
    `DELETE FROM user_push_tokens WHERE organization_id=$1 AND user_id=$2 AND token=$3`,
    [req.user.organization_id, req.user.id, token],
  );
  res.json({ success: true, removed: rowCount });
});

export const getReminderEngineHealth = asyncHandler(async (req, res) => {
  if (!isOrgAdmin(req.user)) return res.status(403).json({ message: 'Administrator access required' });
  const [health, counts] = await Promise.all([
    pool.query(`SELECT * FROM reminder_scheduler_health WHERE worker_name='event_reminder_scheduler'`),
    pool.query(
      `SELECT COUNT(*) FILTER (WHERE status='PENDING')::int AS pending,
              COUNT(*) FILTER (WHERE status='FAILED')::int AS failed,
              COUNT(*) FILTER (WHERE status='PROCESSING')::int AS processing
         FROM event_reminders WHERE organization_id=$1`,
      [req.user.organization_id],
    ),
  ]);
  const row = health.rows[0] || null;
  const healthy = Boolean(row?.last_completed_at)
    && Date.now() - new Date(row.last_completed_at).getTime() < 5 * 60 * 1000
    && !row.last_error;
  res.json({ healthy, worker: row, ...counts.rows[0] });
});

