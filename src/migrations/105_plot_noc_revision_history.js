import 'dotenv/config';
import pool from '../config/db.js';

export async function up() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('105_plot_noc_revision_history'))`);

    await client.query(`
      ALTER TABLE plot_registries
        ADD COLUMN IF NOT EXISTS noc_show_payments BOOLEAN NOT NULL DEFAULT TRUE,
        ADD COLUMN IF NOT EXISTS noc_ack_no VARCHAR(160),
        ADD COLUMN IF NOT EXISTS noc_revision INTEGER NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS noc_generated_by INTEGER REFERENCES users(id) ON DELETE SET NULL
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS plot_registry_noc_history (
        id BIGSERIAL PRIMARY KEY,
        registry_id INTEGER NOT NULL REFERENCES plot_registries(id) ON DELETE CASCADE,
        revision_no INTEGER NOT NULL CHECK (revision_no > 0),
        ref_no VARCHAR(160) NOT NULL,
        ack_no VARCHAR(160) NOT NULL,
        event_type VARCHAR(20) NOT NULL CHECK (event_type IN ('GENERATED', 'REGENERATED')),
        change_note TEXT,
        show_payments BOOLEAN NOT NULL DEFAULT TRUE,
        included_payment_count INTEGER NOT NULL DEFAULT 0,
        included_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
        snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
        generated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (registry_id, revision_no),
        UNIQUE (ack_no)
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_noc_history_registry_date ON plot_registry_noc_history (registry_id, generated_at DESC)`);

    // Preserve NOCs issued before revision tracking as revision 1. Their REF
    // stays untouched and a deterministic ACK is assigned once.
    await client.query(`
      UPDATE plot_registries
         SET noc_revision = GREATEST(noc_revision, 1),
             noc_ack_no = COALESCE(
               NULLIF(noc_ack_no, ''),
               'ACK/NOC/' || LPAD(id::text, 4, '0') || '/R01'
             ),
             noc_generated_by = COALESCE(noc_generated_by, noc_approved_by, created_by),
             noc_show_payments = COALESCE(noc_show_payments, TRUE)
       WHERE noc_generated_at IS NOT NULL
    `);

    await client.query(`
      INSERT INTO plot_registry_noc_history (
        registry_id, revision_no, ref_no, ack_no, event_type, change_note,
        show_payments, included_payment_count, included_amount, snapshot,
        generated_by, generated_at
      )
      SELECT
        pr.id,
        1,
        COALESCE(NULLIF(pr.noc_no, ''), 'NOC/RG/' || EXTRACT(YEAR FROM pr.noc_generated_at)::int || '/' || LPAD(pr.id::text, 4, '0')),
        pr.noc_ack_no,
        'GENERATED',
        'Imported from the NOC issued before revision history was enabled',
        pr.noc_show_payments,
        COALESCE(payments.payment_count, 0),
        COALESCE(payments.payment_total, 0),
        jsonb_build_object(
          'legacy_backfill', TRUE,
          'noc', jsonb_build_object(
            'ref_no', COALESCE(NULLIF(pr.noc_no, ''), 'NOC/RG/' || EXTRACT(YEAR FROM pr.noc_generated_at)::int || '/' || LPAD(pr.id::text, 4, '0')),
            'ack_no', pr.noc_ack_no,
            'revision_no', 1,
            'noc_date', pr.noc_date,
            'noc_place', pr.noc_place,
            'noc_notes', pr.noc_notes,
            'show_payments', pr.noc_show_payments
          ),
          'payments', COALESCE(payments.payment_rows, '[]'::jsonb),
          'totals', jsonb_build_object(
            'included_count', COALESCE(payments.payment_count, 0),
            'included_amount', COALESCE(payments.payment_total, 0)
          )
        ),
        pr.noc_generated_by,
        pr.noc_generated_at
      FROM plot_registries pr
      LEFT JOIN LATERAL (
        SELECT
          COUNT(*)::integer AS payment_count,
          COALESCE(SUM(x.amount), 0)::numeric AS payment_total,
          COALESCE(jsonb_agg(x.payment ORDER BY x.payment_date, x.payment_id), '[]'::jsonb) AS payment_rows
        FROM (
          SELECT
            prp.id AS payment_id,
            prp.payment_date,
            prp.amount,
            jsonb_build_object(
              'id', prp.id,
              'source_plot_payment_id', prp.source_plot_payment_id,
              'date', prp.payment_date,
              'amount', prp.amount,
              'mode', prp.payment_mode,
              'notes', prp.notes
            ) AS payment
          FROM plot_registry_payments prp
          LEFT JOIN plot_payments pp ON pp.id = prp.source_plot_payment_id
          WHERE prp.registry_id = pr.id
            AND COALESCE(prp.include_in_noc, FALSE)
            AND (
              (prp.source_plot_payment_id IS NULL
                AND LOWER(COALESCE(prp.status, 'approved')) = 'approved'
                AND UPPER(COALESCE(prp.cheque_status, '')) NOT IN ('BOUNCED', 'RETURNED', 'PENDING'))
              OR
              (prp.source_plot_payment_id IS NOT NULL
                AND LOWER(COALESCE(pp.status, 'approved')) = 'approved'
                AND UPPER(COALESCE(pp.cheque_status, '')) NOT IN ('BOUNCED', 'RETURNED', 'PENDING'))
            )
        ) x
      ) payments ON TRUE
      WHERE pr.noc_generated_at IS NOT NULL
      ON CONFLICT (registry_id, revision_no) DO NOTHING
    `);

    // History is evidence: revisions can be appended, never rewritten or
    // deleted independently of their parent registry.
    await client.query(`
      CREATE OR REPLACE FUNCTION prevent_plot_registry_noc_history_mutation()
      RETURNS TRIGGER AS $$
      BEGIN
        RAISE EXCEPTION 'plot_registry_noc_history is append-only';
      END;
      $$ LANGUAGE plpgsql
    `);
    await client.query(`DROP TRIGGER IF EXISTS trg_plot_registry_noc_history_append_only ON plot_registry_noc_history`);
    await client.query(`
      CREATE TRIGGER trg_plot_registry_noc_history_append_only
      BEFORE UPDATE OR DELETE ON plot_registry_noc_history
      FOR EACH ROW EXECUTE FUNCTION prevent_plot_registry_noc_history_mutation()
    `);

    await client.query('COMMIT');
    console.log('Migration 105: versioned NOC history is ready');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

up()
  .catch((error) => {
    console.error('Migration 105 failed:', error.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
