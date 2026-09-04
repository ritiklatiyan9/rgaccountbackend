import 'dotenv/config';
import pool from '../config/db.js';

/**
 * Retire email only from the Management Analytics campaign feature.
 * Historical email rows remain readable; NOT VALID constraints reject new
 * email rows without requiring old audit history to be deleted.
 */
export async function up() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('144_remove_client_messaging_email'))`);

    const retired = await client.query(`
      UPDATE client_message_deliveries
         SET status='FAILED', error='Email channel retired from client campaigns', updated_at=NOW()
       WHERE channel='EMAIL' AND status IN ('QUEUED','SENDING')
       RETURNING campaign_id
    `);

    const campaignIds = [...new Set(retired.rows.map((row) => row.campaign_id))];
    if (campaignIds.length) {
      await client.query(`
        WITH totals AS (
          SELECT campaign_id,
                 COUNT(*) FILTER (WHERE status='SENT')::int AS sent,
                 COUNT(*) FILTER (WHERE status='FAILED')::int AS failed,
                 COUNT(*) FILTER (WHERE status='SKIPPED')::int AS skipped,
                 COUNT(*) FILTER (WHERE status IN ('QUEUED','SENDING'))::int AS pending
            FROM client_message_deliveries
           WHERE campaign_id = ANY($1::bigint[])
           GROUP BY campaign_id
        )
        UPDATE client_message_campaigns c
           SET sent_count=t.sent, failed_count=t.failed, skipped_count=t.skipped,
               status=CASE WHEN t.pending > 0 THEN 'SENDING'
                           WHEN t.failed = 0 THEN 'COMPLETED'
                           WHEN t.sent = 0 THEN 'FAILED' ELSE 'PARTIAL' END,
               updated_at=NOW()
          FROM totals t WHERE c.id=t.campaign_id
      `, [campaignIds]);
    }

    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='client_message_campaigns_sms_only') THEN
          ALTER TABLE client_message_campaigns
            ADD CONSTRAINT client_message_campaigns_sms_only
            CHECK (channels = ARRAY['SMS']::text[]) NOT VALID;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='client_message_deliveries_sms_only') THEN
          ALTER TABLE client_message_deliveries
            ADD CONSTRAINT client_message_deliveries_sms_only
            CHECK (channel='SMS') NOT VALID;
        END IF;
      END $$
    `);

    await client.query('COMMIT');
    console.log('Migration 144: email retired; client messaging is SMS-only');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

up()
  .catch((error) => {
    console.error('Migration 144 failed:', error.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
