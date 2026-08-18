import pool from '../config/db.js';
import { mailerEnabled, sendEventReminderEmail } from '../utils/mailer.js';
import { firebaseEnabled, sendFirebaseMessages } from '../config/firebaseAdmin.js';
import {
  DEFAULT_TIME_ZONE, calculateReminderSchedule, deterministicMessageId, isValidTimeZone, reconcileFutureEvents, usefulUntil,
} from './eventReminder.service.js';
import { loadEventSource } from './eventSource.service.js';

const TICK_MS = Math.max(15_000, Number(process.env.EVENT_REMINDER_POLL_MS) || 60_000);
const BATCH_SIZE = Math.min(200, Math.max(1, Number(process.env.EVENT_REMINDER_BATCH_SIZE) || 50));
const WORKER = 'event_reminder_scheduler';
let timer = null;
let startupTimer = null;
let running = false;
let lastReconciledAt = 0;

const formatEvent = (snapshot) => {
  const timeZone = isValidTimeZone(snapshot.timezone) ? snapshot.timezone : DEFAULT_TIME_ZONE;
  const instant = snapshot.eventAt ? new Date(snapshot.eventAt) : null;
  if (!snapshot.timed) {
    const raw = String(snapshot.eventAt || '').slice(0, 10);
    const date = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? new Date(`${raw}T12:00:00Z`) : instant;
    return {
      date: date && !Number.isNaN(date.getTime()) ? new Intl.DateTimeFormat('en-IN', { dateStyle: 'long', timeZone: 'UTC' }).format(date) : '',
      time: null,
    };
  }
  return {
    date: new Intl.DateTimeFormat('en-IN', { dateStyle: 'long', timeZone }).format(instant),
    time: new Intl.DateTimeFormat('en-IN', { timeStyle: 'short', timeZone }).format(instant),
  };
};

async function claimBatch() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // A process that died after claiming gets another chance. The event-level
    // usefulness check below prevents stale recovery from sending old mail.
    await client.query(`UPDATE event_reminders
      SET status='FAILED',next_attempt_at=NOW(),failure_reason='Recovered abandoned worker claim',updated_at=NOW()
      WHERE status='PROCESSING' AND last_attempt_at < NOW()-INTERVAL '15 minutes'`);
    const { rows } = await client.query(
      `WITH due AS (
         SELECT id FROM event_reminders
          WHERE status IN ('PENDING','FAILED') AND attempt_count < 3
            AND next_attempt_at <= NOW() AND scheduled_at <= NOW()
          ORDER BY scheduled_at,id
          FOR UPDATE SKIP LOCKED
          LIMIT $1
       )
       UPDATE event_reminders r
          SET status='PROCESSING',attempt_count=r.attempt_count+1,last_attempt_at=NOW(),updated_at=NOW()
         FROM due WHERE r.id=due.id
       RETURNING r.*`,
      [BATCH_SIZE],
    );
    await client.query('COMMIT');
    return rows;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function markFailure(row, error) {
  const delayMinutes = row.attempt_count <= 1 ? 5 : 15;
  const final = row.attempt_count >= 3;
  await pool.query(
    `UPDATE event_reminders SET status='FAILED',failure_reason=$1,
       next_attempt_at=CASE WHEN $2::boolean THEN next_attempt_at ELSE NOW()+($3::text || ' minutes')::interval END,
       updated_at=NOW() WHERE id=$4 AND status='PROCESSING'`,
    [String(error?.message || error).slice(0, 2000), final, delayMinutes, row.id],
  );
}

async function deliverEmail(row, snapshot) {
  if (!mailerEnabled()) throw new Error('SMTP is not configured');
  if (!row.recipient_email) throw new Error('Reminder recipient has no email');
  const display = formatEvent(snapshot);
  const base = String(process.env.FRONTEND_URL || '').replace(/\/$/, '');
  return sendEventReminderEmail({
    to: row.recipient_email,
    name: row.recipient_name,
    reminderType: row.reminder_type,
    event: snapshot,
    formattedDate: display.date,
    formattedTime: display.time,
    actionUrl: base && snapshot.actionPath ? `${base}${snapshot.actionPath}` : null,
    messageId: deterministicMessageId(row),
  });
}

async function deliverFcm(row, snapshot) {
  if (!firebaseEnabled()) throw new Error('Firebase Admin is not configured');
  if (!row.recipient_user_id) throw new Error('Push reminder has no user');
  const { rows: tokens } = await pool.query(
    `SELECT id,token FROM user_push_tokens WHERE organization_id=$1 AND user_id=$2 ORDER BY last_seen_at DESC LIMIT 10`,
    [row.organization_id, row.recipient_user_id],
  );
  if (!tokens.length) return { skipped: true, reason: 'No browser push subscription' };
  const title = row.reminder_type === 'EVENT_DAY' ? `Today: ${snapshot.title}`
    : row.reminder_type === 'THIRTY_MINUTES_BEFORE' ? `Starting in 30 minutes: ${snapshot.title}`
      : `Reminder: ${snapshot.title} is tomorrow`;
  const frontendBase = String(process.env.FRONTEND_URL || '').replace(/\/$/, '');
  const link = frontendBase && snapshot.actionPath ? `${frontendBase}${snapshot.actionPath}` : frontendBase || undefined;
  const result = await sendFirebaseMessages(tokens.map((item) => item.token), {
    notification: { title, body: snapshot.siteName ? `${snapshot.siteName} · Open in ERP` : 'Open in ERP' },
    ...(link ? { webpush: { fcmOptions: { link } } } : {}),
    data: { eventType: row.event_type, sourceId: String(row.source_id), reminderType: row.reminder_type },
  });
  const invalidIds = tokens.filter((_, index) => {
    const code = result.responses[index]?.error?.code;
    return ['messaging/registration-token-not-registered', 'messaging/invalid-registration-token'].includes(code);
  }).map((item) => item.id);
  if (invalidIds.length) await pool.query('DELETE FROM user_push_tokens WHERE id=ANY($1::bigint[])', [invalidIds]);
  if (!result.successCount) throw new Error('Browser push delivery failed for every registered device');
  return { messageId: `fcm:${result.successCount}` };
}

async function processRow(row) {
  const event = await loadEventSource(row.organization_id, row.event_type, row.source_id);
  const snapshot = row.event_snapshot || {};
  const timeZone = isValidTimeZone(snapshot.timezone) ? snapshot.timezone : DEFAULT_TIME_ZONE;
  const currentSchedule = event?.event_at ? calculateReminderSchedule(event, timeZone)
    .find((item) => item.reminderType === row.reminder_type)?.scheduledAt : null;
  const scheduleStillMatches = currentSchedule
    && Math.abs(currentSchedule.getTime() - new Date(row.scheduled_at).getTime()) < 1000;
  if (!event || event.cancelled || !event.event_at || !scheduleStillMatches || usefulUntil(event, row.reminder_type, timeZone) <= new Date()) {
    await pool.query(
      `UPDATE event_reminders SET status='CANCELLED',failure_reason='Event changed, cancelled, or reminder became stale',updated_at=NOW()
        WHERE id=$1 AND status='PROCESSING'`,
      [row.id],
    );
    return 'cancelled';
  }
  try {
    const result = row.channel === 'EMAIL' ? await deliverEmail(row, snapshot) : await deliverFcm(row, snapshot);
    await pool.query(
      `UPDATE event_reminders SET status=$1,sent_at=CASE WHEN $1='SENT' THEN NOW() ELSE sent_at END,
         provider_message_id=$2,failure_reason=$3,updated_at=NOW()
       WHERE id=$4 AND status='PROCESSING'`,
      [result.skipped ? 'SKIPPED' : 'SENT', result.messageId || null, result.reason || null, row.id],
    );
    await pool.query(
      `INSERT INTO compliance_audit_log
        (organization_id,site_id,action,entity_type,entity_id,new_value)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
      [row.organization_id, row.site_id, result.skipped ? 'REMINDER_SKIPPED' : 'REMINDER_SENT',
        row.event_type, row.source_id, JSON.stringify({ reminderId: row.id, channel: row.channel, recipient: row.recipient_key })],
    );
    return result.skipped ? 'skipped' : 'sent';
  } catch (error) {
    await markFailure(row, error);
    await pool.query(
      `INSERT INTO compliance_audit_log
        (organization_id,site_id,action,entity_type,entity_id,new_value,reason)
       VALUES ($1,$2,'REMINDER_FAILED',$3,$4,$5::jsonb,$6)`,
      [row.organization_id, row.site_id, row.event_type, row.source_id,
        JSON.stringify({ reminderId: row.id, channel: row.channel, attempt: row.attempt_count }),
        String(error?.message || error).slice(0, 2000)],
    );
    return 'failed';
  }
}

export async function runEventReminderScheduler() {
  if (running) return { skipped: true };
  running = true;
  const started = new Date();
  try {
    await pool.query(
      `INSERT INTO reminder_scheduler_health (worker_name,last_started_at,last_error,updated_at)
       VALUES ($1,$2,NULL,NOW()) ON CONFLICT (worker_name) DO UPDATE SET last_started_at=$2,last_error=NULL,updated_at=NOW()`,
      [WORKER, started],
    );
    const rows = await claimBatch();
    const outcomes = { sent: 0, failed: 0, skipped: 0, cancelled: 0 };
    for (const row of rows) outcomes[await processRow(row)] += 1;
    if (Date.now() - lastReconciledAt > 6 * 60 * 60 * 1000) {
      await reconcileFutureEvents();
      lastReconciledAt = Date.now();
    }
    await pool.query(
      `UPDATE reminder_scheduler_health SET last_completed_at=NOW(),processed_count=processed_count+$2,updated_at=NOW()
        WHERE worker_name=$1`,
      [WORKER, rows.length],
    );
    return { claimed: rows.length, ...outcomes };
  } catch (error) {
    await pool.query(
      `INSERT INTO reminder_scheduler_health (worker_name,last_started_at,last_error,updated_at)
       VALUES ($1,$2,$3,NOW()) ON CONFLICT (worker_name) DO UPDATE SET last_error=$3,updated_at=NOW()`,
      [WORKER, started, String(error.message || error).slice(0, 2000)],
    ).catch(() => {});
    throw error;
  } finally {
    running = false;
  }
}

export function startEventReminderScheduler() {
  if (timer || process.env.EVENT_REMINDER_SCHEDULER === 'off') return;
  const tick = () => runEventReminderScheduler().catch((error) => console.error('[reminders] scheduler failed:', error.message));
  timer = setInterval(tick, TICK_MS);
  timer.unref?.();
  startupTimer = setTimeout(async () => {
    await tick();
  }, 15_000);
  startupTimer.unref?.();
  console.log(`[reminders] database scheduler started (${TICK_MS}ms poll)`);
}

export function stopEventReminderScheduler() {
  if (timer) clearInterval(timer);
  if (startupTimer) clearTimeout(startupTimer);
  timer = null;
  startupTimer = null;
}
