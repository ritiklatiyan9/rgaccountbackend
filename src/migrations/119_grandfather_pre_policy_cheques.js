import 'dotenv/config';
import pool from '../config/db.js';

/**
 * Migration 119 — grandfather pre-policy cheques into the 118 posting rule.
 *
 * 118 introduced: a cheque posts only once `cheque_status = 'CLEARED'`. That is right
 * going forward, but the clearing step had never been used operationally — only ~135
 * cheques were ever marked CLEARED while ~1,059 sat at the PENDING default, spanning
 * 2021-2026. Applying the new rule to that history erased ₹26+ crore of receipts and
 * ₹6+ crore of payments from every balance (Mount Valley alone swung +₹18.2 L → −₹6.04 cr).
 *
 * Two changes, both aimed at "history keeps its old meaning, new cheques follow 118":
 *
 *   1. A row with NO cheque_status at all never entered the clearing workflow, so it is
 *      not "in flight" — it posts under the normal credit/debit rules. (118 suppressed it
 *      because payment_mode said CHEQUE.)
 *   2. Cheques DATED BEFORE the policy start are marked CLEARED. For a 2021-2025 cheque
 *      that was approved and never bounced, clearing is what actually happened; the app
 *      simply never recorded it. BOUNCED / RETURNED rows are never touched. Cheques dated
 *      on or after the cutoff are left alone, so the strict rule governs from here on.
 *
 * Idempotent: re-running finds nothing left to convert.
 */
const POLICY_START = process.env.CHEQUE_POLICY_START || '2026-08-30';

export async function up() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('119_grandfather_pre_policy_cheques'))`);

    // ── 1. Posting rule: an unmanaged cheque (no status) is not in-flight ──
    await client.query(`
      CREATE OR REPLACE FUNCTION financial_transaction_posts(
        p_direction TEXT,
        p_status TEXT,
        p_payment_mode TEXT,
        p_cheque_status TEXT
      ) RETURNS BOOLEAN
      LANGUAGE SQL
      IMMUTABLE
      PARALLEL SAFE
      AS $$
        SELECT CASE
          WHEN LOWER(COALESCE(NULLIF(TRIM(p_status), ''), 'approved'))
                 IN ('rejected', 'cancelled', 'deleted', 'void', 'voided')
            THEN FALSE
          -- Explicitly in the clearing workflow: posts only once it clears.
          -- No cheque_status at all = legacy row predating the workflow → normal rules.
          WHEN NULLIF(TRIM(COALESCE(p_cheque_status, '')), '') IS NOT NULL
               AND UPPER(TRIM(p_cheque_status)) <> 'CLEARED'
            THEN FALSE
          WHEN LOWER(COALESCE(TRIM(p_direction), '')) = 'credit'
            THEN TRUE
          WHEN LOWER(COALESCE(TRIM(p_direction), '')) = 'debit'
            THEN LOWER(COALESCE(NULLIF(TRIM(p_status), ''), 'approved')) = 'approved'
          ELSE FALSE
        END
      $$
    `);

    // ── 2. Grandfather pre-policy PENDING cheques ──
    // Every table that tracks cheque_status, paired with its own date column.
    const { rows: targets } = await client.query(`
      SELECT c.table_name,
             COALESCE(
               MAX(CASE WHEN d.column_name = 'date' THEN 'date' END),
               MAX(CASE WHEN d.column_name = 'payment_date' THEN 'payment_date' END),
               MAX(CASE WHEN d.column_name = 'created_at' THEN 'created_at' END)
             ) AS date_column
        FROM information_schema.columns c
        -- BASE TABLE only: ledger_entries and friends are VIEWS over these rows and
        -- cannot be updated (that is what made the first run fail).
        JOIN information_schema.tables t
          ON t.table_schema = c.table_schema
         AND t.table_name = c.table_name
         AND t.table_type = 'BASE TABLE'
        JOIN information_schema.columns d
          ON d.table_name = c.table_name AND d.table_schema = c.table_schema
       WHERE c.table_schema = 'public' AND c.column_name = 'cheque_status'
       GROUP BY c.table_name
       ORDER BY c.table_name
    `);

    const summary = [];
    for (const { table_name: table, date_column: dateCol } of targets) {
      if (!dateCol) { summary.push(`${table}: skipped (no date column)`); continue; }
      const { rows } = await client.query(
        `UPDATE ${table}
            SET cheque_status = 'CLEARED'
          WHERE UPPER(COALESCE(cheque_status, '')) = 'PENDING'
            AND ${dateCol} < $1::date
          RETURNING 1`,
        [POLICY_START]
      );
      if (rows.length) summary.push(`${table}: ${rows.length}`);
    }

    await client.query(
      `INSERT INTO app_schema_migrations (version) VALUES ('119_grandfather_pre_policy_cheques')
       ON CONFLICT (version) DO NOTHING`
    );
    await client.query('COMMIT');
    console.log(`Migration 119: pre-${POLICY_START} cheques grandfathered — ${summary.join(', ') || 'nothing to convert'}`);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

up()
  .catch((error) => { console.error('Migration 119 failed:', error.message); process.exitCode = 1; })
  .finally(() => pool.end());
