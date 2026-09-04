import 'dotenv/config';
import pool from '../config/db.js';

/**
 * Durable, auditable outbound client messaging for Management Analytics.
 * Campaigns hold the site-scoped audience and operator intent; deliveries are
 * immutable recipient snapshots that the SQS worker advances independently.
 */
export async function up() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('142_client_messaging_campaigns'))`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS client_message_campaigns (
        id                       BIGSERIAL PRIMARY KEY,
        site_id                  INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
        title                    VARCHAR(180) NOT NULL,
        message                  TEXT NOT NULL,
        channels                 TEXT[] NOT NULL,
        message_type             VARCHAR(20) NOT NULL DEFAULT 'TRANSACTIONAL'
                                   CHECK (message_type IN ('TRANSACTIONAL','PROMOTIONAL')),
        audience_mode            VARCHAR(20) NOT NULL
                                   CHECK (audience_mode IN ('SELECTED','FILTERED')),
        audience_filters         JSONB NOT NULL DEFAULT '{}'::jsonb,
        recipient_count          INTEGER NOT NULL DEFAULT 0,
        delivery_count           INTEGER NOT NULL DEFAULT 0,
        queued_count             INTEGER NOT NULL DEFAULT 0,
        sent_count               INTEGER NOT NULL DEFAULT 0,
        failed_count             INTEGER NOT NULL DEFAULT 0,
        skipped_count            INTEGER NOT NULL DEFAULT 0,
        status                   VARCHAR(20) NOT NULL DEFAULT 'QUEUING'
                                   CHECK (status IN ('QUEUING','QUEUED','SENDING','COMPLETED','PARTIAL','FAILED')),
        consent_confirmed        BOOLEAN NOT NULL DEFAULT FALSE,
        consent_confirmed_at     TIMESTAMPTZ,
        created_by               INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CHECK (cardinality(channels) = 1),
        CHECK (channels = ARRAY['SMS']::text[])
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS client_message_deliveries (
        id                  BIGSERIAL PRIMARY KEY,
        campaign_id         BIGINT NOT NULL REFERENCES client_message_campaigns(id) ON DELETE CASCADE,
        site_id             INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
        member_id           INTEGER REFERENCES members(id) ON DELETE SET NULL,
        client_name         VARCHAR(255) NOT NULL,
        channel             VARCHAR(12) NOT NULL CHECK (channel = 'SMS'),
        destination         VARCHAR(320) NOT NULL,
        rendered_subject    VARCHAR(200),
        rendered_message    TEXT NOT NULL,
        status              VARCHAR(16) NOT NULL DEFAULT 'QUEUED'
                              CHECK (status IN ('QUEUED','SENDING','SENT','FAILED','SKIPPED')),
        provider            VARCHAR(40) NOT NULL DEFAULT 'AWS',
        provider_message_id VARCHAR(255),
        error               VARCHAR(1000),
        attempt_count       INTEGER NOT NULL DEFAULT 0,
        queued_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        sent_at             TIMESTAMPTZ,
        updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (campaign_id, member_id, channel)
      )
    `);

    await client.query(`CREATE INDEX IF NOT EXISTS idx_client_message_campaigns_site_created ON client_message_campaigns(site_id, created_at DESC)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_client_message_deliveries_campaign_status ON client_message_deliveries(campaign_id, status)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_client_message_deliveries_site_member ON client_message_deliveries(site_id, member_id, queued_at DESC)`);

    await client.query('COMMIT');
    console.log('Migration 142: client messaging campaigns ready');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

up()
  .catch((error) => {
    console.error('Migration 142 failed:', error.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
