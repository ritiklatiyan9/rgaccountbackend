import 'dotenv/config';
import pool from '../config/db.js';

const POLICY_START = process.env.CHEQUE_POLICY_START || '2026-08-30';

/**
 * Migration 133 — make plot-payment cheque state complete and self-healing.
 *
 * Historical imports were allowed to omit cheque_status because the column
 * defaulted to NULL.  Preserve migration 119's accounting policy while
 * bringing those rows into the visible cheque workflow:
 *   - pre-policy cheques become CLEARED;
 *   - newer cheques become PENDING.
 *
 * A small source trigger enforces the invariant for API writes and direct
 * imports.  A separate AFTER trigger repairs the cash-flow projection because
 * sync_cashflow_from_modules() intentionally does not own cheque metadata.
 */
export async function up() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('133_plot_payment_cheque_invariant'))`);

    await client.query(`
      CREATE OR REPLACE FUNCTION normalize_plot_payment_cheque()
      RETURNS TRIGGER
      LANGUAGE plpgsql
      AS $$
      BEGIN
        IF UPPER(TRIM(COALESCE(NEW.payment_type, ''))) = 'CHEQUE'
           OR UPPER(TRIM(COALESCE(NEW.payment_from, ''))) = 'CHEQUE' THEN
          NEW.payment_type := 'CHEQUE';
          NEW.cheque_status := CASE
            WHEN UPPER(TRIM(COALESCE(NEW.cheque_status, ''))) IN
                 ('PENDING', 'CLEARED', 'BOUNCED', 'RETURNED')
              THEN UPPER(TRIM(NEW.cheque_status))
            ELSE 'PENDING'
          END;

          IF NULLIF(TRIM(COALESCE(NEW.cheque_no, '')), '') IS NULL
             AND NULLIF(TRIM(COALESCE(NEW.bank_details, '')), '') IS NOT NULL THEN
            NEW.cheque_no := TRIM(NEW.bank_details);
          END IF;
        ELSIF NULLIF(TRIM(COALESCE(NEW.cheque_status, '')), '') IS NOT NULL THEN
          NEW.cheque_status := CASE
            WHEN UPPER(TRIM(NEW.cheque_status)) IN ('PENDING', 'CLEARED', 'BOUNCED', 'RETURNED')
              THEN UPPER(TRIM(NEW.cheque_status))
            ELSE NULL
          END;
        END IF;
        RETURN NEW;
      END;
      $$
    `);

    // Normalize the source before its cheque status is mirrored to cash flow.
    await client.query(`DROP TRIGGER IF EXISTS trg_aa_plot_payment_cheque_invariant ON plot_payments`);
    await client.query(`
      CREATE TRIGGER trg_aa_plot_payment_cheque_invariant
      BEFORE INSERT OR UPDATE ON plot_payments
      FOR EACH ROW EXECUTE FUNCTION normalize_plot_payment_cheque()
    `);

    const repairedSources = await client.query(
      `UPDATE plot_payments
          SET cheque_status = CASE
                WHEN date < $1::date THEN 'CLEARED'
                ELSE 'PENDING'
              END,
              cheque_no = COALESCE(
                NULLIF(TRIM(cheque_no), ''),
                NULLIF(TRIM(bank_details), '')
              )
        WHERE (
                UPPER(TRIM(COALESCE(payment_type, ''))) = 'CHEQUE'
                OR UPPER(TRIM(COALESCE(payment_from, ''))) = 'CHEQUE'
              )
          AND NULLIF(TRIM(COALESCE(cheque_status, '')), '') IS NULL
      RETURNING id`,
      [POLICY_START],
    );

    await client.query(`
      CREATE OR REPLACE FUNCTION sync_plot_payment_cheque_mirror()
      RETURNS TRIGGER
      LANGUAGE plpgsql
      AS $$
      BEGIN
        UPDATE cash_flow_entries
           SET cheque_status = NEW.cheque_status,
               cheque_no = NEW.cheque_no,
               cash_type = CASE
                 WHEN UPPER(TRIM(COALESCE(NEW.payment_type, ''))) = 'CASH' THEN 'cash'
                 WHEN UPPER(TRIM(COALESCE(NEW.payment_type, ''))) IN ('CHEQUE', 'CHECK') THEN 'cheque'
                 ELSE 'bank'
               END,
               updated_at = NOW()
         WHERE source_module = 'plot_payments'
           AND source_id = NEW.id
           AND (cash_type, cheque_status, cheque_no)
               IS DISTINCT FROM (
                 CASE
                   WHEN UPPER(TRIM(COALESCE(NEW.payment_type, ''))) = 'CASH' THEN 'cash'
                   WHEN UPPER(TRIM(COALESCE(NEW.payment_type, ''))) IN ('CHEQUE', 'CHECK') THEN 'cheque'
                   ELSE 'bank'
                 END,
                 NEW.cheque_status,
                 NEW.cheque_no
               );
        RETURN NEW;
      END;
      $$
    `);

    await client.query(`DROP TRIGGER IF EXISTS trg_zy_plot_payment_cheque_mirror ON plot_payments`);
    await client.query(`
      CREATE TRIGGER trg_zy_plot_payment_cheque_mirror
      AFTER INSERT OR UPDATE ON plot_payments
      FOR EACH ROW EXECUTE FUNCTION sync_plot_payment_cheque_mirror()
    `);

    const repairedMirrors = await client.query(`
      UPDATE cash_flow_entries cfe
         SET cash_type = CASE
               WHEN UPPER(TRIM(COALESCE(pp.payment_type, ''))) = 'CASH' THEN 'cash'
               WHEN UPPER(TRIM(COALESCE(pp.payment_type, ''))) IN ('CHEQUE', 'CHECK') THEN 'cheque'
               ELSE 'bank'
             END,
             cheque_status = pp.cheque_status,
             cheque_no = pp.cheque_no,
             updated_at = NOW()
        FROM plot_payments pp
       WHERE cfe.source_module = 'plot_payments'
         AND cfe.source_id = pp.id
         AND (cfe.cash_type, cfe.cheque_status, cfe.cheque_no)
             IS DISTINCT FROM (
               CASE
                 WHEN UPPER(TRIM(COALESCE(pp.payment_type, ''))) = 'CASH' THEN 'cash'
                 WHEN UPPER(TRIM(COALESCE(pp.payment_type, ''))) IN ('CHEQUE', 'CHECK') THEN 'cheque'
                 ELSE 'bank'
               END,
               pp.cheque_status,
               pp.cheque_no
             )
      RETURNING cfe.id
    `);

    await client.query(`ALTER TABLE plot_payments DROP CONSTRAINT IF EXISTS plot_payments_cheque_status_valid`);
    await client.query(`
      ALTER TABLE plot_payments
      ADD CONSTRAINT plot_payments_cheque_status_valid
      CHECK (
        cheque_status IS NULL
        OR cheque_status IN ('PENDING', 'CLEARED', 'BOUNCED', 'RETURNED')
      )
    `);

    await client.query(`ALTER TABLE plot_payments DROP CONSTRAINT IF EXISTS plot_payments_cheque_requires_status`);
    await client.query(`
      ALTER TABLE plot_payments
      ADD CONSTRAINT plot_payments_cheque_requires_status
      CHECK (
        UPPER(TRIM(COALESCE(payment_type, ''))) <> 'CHEQUE'
        OR cheque_status IS NOT NULL
      )
    `);

    await client.query(`
      INSERT INTO app_schema_migrations (version)
      VALUES ('133_plot_payment_cheque_invariant')
      ON CONFLICT (version) DO NOTHING
    `);
    await client.query('COMMIT');
    console.log(
      `Migration 133: repaired ${repairedSources.rowCount} plot cheque statuses and ${repairedMirrors.rowCount} cash-flow mirrors`,
    );
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

up()
  .catch((error) => { console.error('Migration 133 failed:', error.message); process.exitCode = 1; })
  .finally(() => pool.end());
