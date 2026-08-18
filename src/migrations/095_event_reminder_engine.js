import 'dotenv/config';
import pool from '../config/db.js';

const MIGRATION_KEY = '095_event_reminder_engine_v1';

async function migrate() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [MIGRATION_KEY]);

    await client.query(`
      CREATE TABLE IF NOT EXISTS event_reminder_preferences (
        id BIGSERIAL PRIMARY KEY,
        organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        site_id INTEGER REFERENCES sites(id) ON DELETE CASCADE,
        event_type VARCHAR(40) NOT NULL,
        source_id BIGINT NOT NULL,
        timezone VARCHAR(100) NOT NULL DEFAULT 'Asia/Kolkata',
        email_day_before BOOLEAN NOT NULL DEFAULT TRUE,
        email_event_day BOOLEAN NOT NULL DEFAULT TRUE,
        email_thirty_minutes BOOLEAN NOT NULL DEFAULT TRUE,
        calendar_enabled BOOLEAN NOT NULL DEFAULT TRUE,
        fcm_enabled BOOLEAN NOT NULL DEFAULT FALSE,
        assigned_user_ids INTEGER[] NOT NULL DEFAULT '{}',
        additional_emails TEXT[] NOT NULL DEFAULT '{}',
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (organization_id, event_type, source_id)
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_event_reminder_preferences_site
      ON event_reminder_preferences (organization_id, site_id, event_type)`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS event_reminders (
        id BIGSERIAL PRIMARY KEY,
        organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        site_id INTEGER REFERENCES sites(id) ON DELETE CASCADE,
        event_type VARCHAR(40) NOT NULL,
        source_id BIGINT NOT NULL,
        reminder_type VARCHAR(40) NOT NULL
          CHECK (reminder_type IN ('DAY_BEFORE','EVENT_DAY','THIRTY_MINUTES_BEFORE')),
        channel VARCHAR(20) NOT NULL CHECK (channel IN ('EMAIL','FCM')),
        scheduled_at TIMESTAMPTZ NOT NULL,
        recipient_key VARCHAR(320) NOT NULL,
        recipient_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        recipient_email VARCHAR(255),
        recipient_name VARCHAR(255),
        status VARCHAR(20) NOT NULL DEFAULT 'PENDING'
          CHECK (status IN ('PENDING','PROCESSING','SENT','FAILED','CANCELLED','SKIPPED')),
        attempt_count INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_attempt_at TIMESTAMPTZ,
        sent_at TIMESTAMPTZ,
        provider_message_id TEXT,
        failure_reason TEXT,
        event_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (organization_id, event_type, source_id, reminder_type, channel, scheduled_at, recipient_key)
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_event_reminders_due
      ON event_reminders (next_attempt_at, scheduled_at, id)
      WHERE status IN ('PENDING','FAILED')`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_event_reminders_event
      ON event_reminders (organization_id, event_type, source_id, created_at DESC)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_event_reminders_site
      ON event_reminders (organization_id, site_id, status, scheduled_at)`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS user_push_tokens (
        id BIGSERIAL PRIMARY KEY,
        organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token TEXT NOT NULL,
        user_agent VARCHAR(500),
        last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (token)
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_user_push_tokens_recipient
      ON user_push_tokens (organization_id, user_id, last_seen_at DESC)`);

    await client.query(`ALTER TABLE google_calendar_event_links
      ADD COLUMN IF NOT EXISTS sync_status VARCHAR(20) NOT NULL DEFAULT 'PENDING'`);
    await client.query(`ALTER TABLE google_calendar_event_links
      ADD COLUMN IF NOT EXISTS last_synced_at TIMESTAMPTZ`);
    await client.query(`ALTER TABLE google_calendar_event_links
      ADD COLUMN IF NOT EXISTS last_attempt_at TIMESTAMPTZ`);
    await client.query(`ALTER TABLE google_calendar_event_links
      ADD COLUMN IF NOT EXISTS sync_attempt_count INTEGER NOT NULL DEFAULT 0`);
    await client.query(`ALTER TABLE google_calendar_event_links
      ADD COLUMN IF NOT EXISTS failure_reason TEXT`);
    await client.query(`ALTER TABLE google_calendar_event_links
      ADD COLUMN IF NOT EXISTS google_html_link TEXT`);
    await client.query(`ALTER TABLE google_calendar_event_links
      ADD COLUMN IF NOT EXISTS remote_updated_at TIMESTAMPTZ`);
    await client.query(`ALTER TABLE google_calendar_event_links
      ALTER COLUMN google_event_id DROP NOT NULL`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS reminder_scheduler_health (
        worker_name VARCHAR(80) PRIMARY KEY,
        last_started_at TIMESTAMPTZ,
        last_completed_at TIMESTAMPTZ,
        last_error TEXT,
        processed_count INTEGER NOT NULL DEFAULT 0,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await client.query(`
      INSERT INTO public.app_schema_migrations (version) VALUES ($1)
      ON CONFLICT (version) DO NOTHING
    `, [MIGRATION_KEY]);
    await client.query('COMMIT');
    console.log(`Migration ${MIGRATION_KEY} complete`);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(`Migration ${MIGRATION_KEY} failed:`, error.message);
    throw error;
  } finally {
    client.release();
  }
}

migrate().then(() => process.exit(0)).catch(() => process.exit(1));
