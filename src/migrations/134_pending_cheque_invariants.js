import 'dotenv/config';
import pool from '../config/db.js';

const POLICY_START = process.env.CHEQUE_POLICY_START || '2026-08-30';
const VALID_STATUSES = "'PENDING', 'CLEARED', 'BOUNCED', 'RETURNED'";

// Keep this list aligned with chequeMatching.service.js and
// chequeStatus.service.js. Plot payments have an additional payment_from
// discriminator and are already protected by migration 133.
const SOURCES = Object.freeze([
  { table: 'farmer_payments', mode: 'payment_mode', date: 'date' },
  { table: 'plot_commission_payments', mode: 'payment_mode', date: 'date' },
  { table: 'firm_transactions', mode: 'payment_mode', date: 'date' },
  { table: 'plot_installment_payments', mode: 'payment_mode', date: 'payment_date' },
  { table: 'expenses', mode: 'payment_mode', date: 'date' },
  { table: 'vendor_payments', mode: 'payment_mode', date: 'payment_date' },
  { table: 'vendor_inventory_payments', mode: 'payment_mode', date: 'payment_date' },
  { table: 'plot_registry_payments', mode: 'payment_mode', date: 'payment_date' },
  { table: 'land_deal_payments', mode: 'payment_mode', date: 'date' },
  { table: 'misc_income_entries', mode: 'payment_mode', date: 'date' },
  { table: 'day_book', mode: 'payment_mode', date: 'date' },
]);

/**
 * Migration 134 — make every pending-cheque source complete and self-healing.
 *
 * The reconciliation screen intentionally trusts the source module, not its
 * cash-flow projection. A source cheque with cheque_status = NULL therefore
 * vanished from the pending list. Controllers normally supply PENDING, but
 * imports, older update paths and direct SQL could omit it.
 *
 * This migration closes every route to that state:
 *   1. BEFORE triggers normalize all future cheque writes to PENDING.
 *   2. CHECK constraints make a missing/invalid status impossible.
 *   3. AFTER triggers keep cash_flow_entries status and number synchronized.
 *   4. Existing blanks retain the migration-119 accounting policy: historical
 *      rows are CLEARED and rows on/after the policy date are PENDING.
 */
export async function up() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('134_pending_cheque_invariants'))`);
    const alreadyApplied = await client.query(`
      SELECT 1 FROM app_schema_migrations
       WHERE version = '134_pending_cheque_invariants'
       LIMIT 1
    `);
    if (alreadyApplied.rowCount) {
      await client.query('COMMIT');
      console.log('Migration 134: already applied');
      return;
    }

    await client.query(`
      CREATE OR REPLACE FUNCTION normalize_accounting_cheque_source()
      RETURNS TRIGGER
      LANGUAGE plpgsql
      AS $$
      DECLARE
        v_mode TEXT;
      BEGIN
        v_mode := UPPER(TRIM(COALESCE(to_jsonb(NEW) ->> TG_ARGV[0], '')));

        IF v_mode IN ('CHEQUE', 'CHECK') THEN
          NEW.cheque_status := CASE
            WHEN UPPER(TRIM(COALESCE(NEW.cheque_status, ''))) IN
                 ('PENDING', 'CLEARED', 'BOUNCED', 'RETURNED')
              THEN UPPER(TRIM(NEW.cheque_status))
            ELSE 'PENDING'
          END;
        ELSIF NULLIF(TRIM(COALESCE(NEW.cheque_status, '')), '') IS NOT NULL THEN
          NEW.cheque_status := CASE
            WHEN UPPER(TRIM(NEW.cheque_status)) IN
                 ('PENDING', 'CLEARED', 'BOUNCED', 'RETURNED')
              THEN UPPER(TRIM(NEW.cheque_status))
            ELSE NULL
          END;
        END IF;

        IF NULLIF(TRIM(COALESCE(NEW.cheque_no, '')), '') IS NULL THEN
          NEW.cheque_no := NULL;
        ELSE
          NEW.cheque_no := TRIM(NEW.cheque_no);
        END IF;

        RETURN NEW;
      END;
      $$
    `);

    await client.query(`
      CREATE OR REPLACE FUNCTION sync_accounting_cheque_mirror()
      RETURNS TRIGGER
      LANGUAGE plpgsql
      AS $$
      DECLARE
        v_mode TEXT;
        v_cash_type TEXT;
      BEGIN
        v_mode := UPPER(TRIM(COALESCE(to_jsonb(NEW) ->> TG_ARGV[1], '')));
        v_cash_type := CASE
          WHEN v_mode = 'CASH' THEN 'cash'
          WHEN v_mode IN ('CHEQUE', 'CHECK') THEN 'cheque'
          ELSE 'bank'
        END;

        UPDATE cash_flow_entries
           SET cash_type = v_cash_type,
               cheque_status = NEW.cheque_status,
               cheque_no = NEW.cheque_no,
               updated_at = NOW()
         WHERE source_module = TG_ARGV[0]
           AND source_id = NEW.id
           AND (cash_type, cheque_status, cheque_no)
               IS DISTINCT FROM (v_cash_type, NEW.cheque_status, NEW.cheque_no);
        RETURN NEW;
      END;
      $$
    `);

    // Migration 133 owns plot-payment normalization; extend its mirror function
    // here so a stale cash_type cannot force a NULL non-cheque status back to
    // PENDING through the cash-flow invariant.
    await client.query(`
      CREATE OR REPLACE FUNCTION sync_plot_payment_cheque_mirror()
      RETURNS TRIGGER
      LANGUAGE plpgsql
      AS $$
      DECLARE
        v_cash_type TEXT;
      BEGIN
        v_cash_type := CASE
          WHEN UPPER(TRIM(COALESCE(NEW.payment_type, ''))) = 'CASH' THEN 'cash'
          WHEN UPPER(TRIM(COALESCE(NEW.payment_type, ''))) IN ('CHEQUE', 'CHECK') THEN 'cheque'
          ELSE 'bank'
        END;
        UPDATE cash_flow_entries
           SET cash_type = v_cash_type,
               cheque_status = NEW.cheque_status,
               cheque_no = NEW.cheque_no,
               updated_at = NOW()
         WHERE source_module = 'plot_payments'
           AND source_id = NEW.id
           AND (cash_type, cheque_status, cheque_no)
               IS DISTINCT FROM (v_cash_type, NEW.cheque_status, NEW.cheque_no);
        RETURN NEW;
      END;
      $$
    `);

    // A source-linked registry row is only an NOC projection. Its cheque state
    // must always come from the canonical plot payment and must never drift if
    // a generic registry edit attempts to change it independently.
    await client.query(`
      CREATE OR REPLACE FUNCTION enforce_linked_registry_cheque_source()
      RETURNS TRIGGER
      LANGUAGE plpgsql
      AS $$
      BEGIN
        IF NEW.source_plot_payment_id IS NOT NULL THEN
          SELECT pp.payment_type, pp.cheque_status, pp.cheque_no
            INTO NEW.payment_mode, NEW.cheque_status, NEW.cheque_no
            FROM plot_payments pp
           WHERE pp.id = NEW.source_plot_payment_id;
        END IF;
        RETURN NEW;
      END;
      $$
    `);

    await client.query(`
      CREATE OR REPLACE FUNCTION sync_plot_payment_registry_cheque()
      RETURNS TRIGGER
      LANGUAGE plpgsql
      AS $$
      BEGIN
        UPDATE plot_registry_payments
           SET payment_mode = NEW.payment_type,
               cheque_status = NEW.cheque_status,
               cheque_no = NEW.cheque_no,
               updated_at = NOW()
         WHERE source_plot_payment_id = NEW.id
           AND (payment_mode, cheque_status, cheque_no)
               IS DISTINCT FROM (NEW.payment_type, NEW.cheque_status, NEW.cheque_no);
        RETURN NEW;
      END;
      $$
    `);

    // Direct cash-flow cheques also participate in matching. Installing this
    // first additionally protects any mirror INSERT performed by older sync
    // functions before a source AFTER trigger copies the authoritative state.
    await client.query(`DROP TRIGGER IF EXISTS trg_aa_cash_flow_cheque_invariant ON cash_flow_entries`);
    await client.query(`
      CREATE TRIGGER trg_aa_cash_flow_cheque_invariant
      BEFORE INSERT OR UPDATE ON cash_flow_entries
      FOR EACH ROW EXECUTE FUNCTION normalize_accounting_cheque_source('cash_type')
    `);

    const summary = [];
    for (const source of SOURCES) {
      const beforeTrigger = `trg_aa_${source.table}_cheque_invariant`;
      const mirrorTrigger = `trg_zz_${source.table}_cheque_mirror`;
      const validConstraint = `${source.table}_cheque_status_valid`;
      const requiredConstraint = `${source.table}_cheque_requires_status`;

      await client.query(`DROP TRIGGER IF EXISTS ${beforeTrigger} ON ${source.table}`);
      await client.query(`
        CREATE TRIGGER ${beforeTrigger}
        BEFORE INSERT OR UPDATE ON ${source.table}
        FOR EACH ROW EXECUTE FUNCTION normalize_accounting_cheque_source('${source.mode}')
      `);

      // The zz prefix makes this run after the existing module-to-cash-flow
      // projection trigger when both are AFTER triggers for the same event.
      await client.query(`DROP TRIGGER IF EXISTS ${mirrorTrigger} ON ${source.table}`);
      await client.query(`
        CREATE TRIGGER ${mirrorTrigger}
        AFTER INSERT OR UPDATE ON ${source.table}
        FOR EACH ROW EXECUTE FUNCTION sync_accounting_cheque_mirror('${source.table}', '${source.mode}')
      `);

      const repaired = await client.query(
        `UPDATE ${source.table}
            SET cheque_status = CASE
                  WHEN ${source.date} < $1::date THEN 'CLEARED'
                  ELSE 'PENDING'
                END
          WHERE UPPER(TRIM(COALESCE(${source.mode}, ''))) IN ('CHEQUE', 'CHECK')
            AND UPPER(TRIM(COALESCE(cheque_status, ''))) NOT IN (${VALID_STATUSES})
        RETURNING id`,
        [POLICY_START],
      );

      const normalized = await client.query(`
        UPDATE ${source.table}
           SET cheque_status = CASE
                 WHEN UPPER(TRIM(COALESCE(cheque_status, ''))) IN (${VALID_STATUSES})
                   THEN UPPER(TRIM(cheque_status))
                 ELSE NULL
               END,
               cheque_no = NULLIF(TRIM(COALESCE(cheque_no, '')), '')
         WHERE (
                 cheque_status IS NOT NULL
                 AND cheque_status IS DISTINCT FROM CASE
                       WHEN UPPER(TRIM(COALESCE(cheque_status, ''))) IN (${VALID_STATUSES})
                         THEN UPPER(TRIM(cheque_status))
                       ELSE NULL
                     END
               )
            OR (
                 cheque_no IS NOT NULL
                 AND cheque_no IS DISTINCT FROM NULLIF(TRIM(COALESCE(cheque_no, '')), '')
               )
        RETURNING id
      `);

      await client.query(`ALTER TABLE ${source.table} DROP CONSTRAINT IF EXISTS ${validConstraint}`);
      await client.query(`
        ALTER TABLE ${source.table}
        ADD CONSTRAINT ${validConstraint}
        CHECK (cheque_status IS NULL OR cheque_status IN (${VALID_STATUSES}))
      `);

      await client.query(`ALTER TABLE ${source.table} DROP CONSTRAINT IF EXISTS ${requiredConstraint}`);
      await client.query(`
        ALTER TABLE ${source.table}
        ADD CONSTRAINT ${requiredConstraint}
        CHECK (
          UPPER(TRIM(COALESCE(${source.mode}, ''))) NOT IN ('CHEQUE', 'CHECK')
          OR cheque_status IS NOT NULL
        )
      `);

      const mirrors = await client.query(`
        UPDATE cash_flow_entries cfe
           SET cash_type = CASE
                 WHEN UPPER(TRIM(COALESCE(source.${source.mode}, ''))) = 'CASH' THEN 'cash'
                 WHEN UPPER(TRIM(COALESCE(source.${source.mode}, ''))) IN ('CHEQUE', 'CHECK') THEN 'cheque'
                 ELSE 'bank'
               END,
               cheque_status = source.cheque_status,
               cheque_no = source.cheque_no,
               updated_at = NOW()
          FROM ${source.table} source
         WHERE cfe.source_module = '${source.table}'
           AND cfe.source_id = source.id
           AND (cfe.cash_type, cfe.cheque_status, cfe.cheque_no)
               IS DISTINCT FROM (
                 CASE
                   WHEN UPPER(TRIM(COALESCE(source.${source.mode}, ''))) = 'CASH' THEN 'cash'
                   WHEN UPPER(TRIM(COALESCE(source.${source.mode}, ''))) IN ('CHEQUE', 'CHECK') THEN 'cheque'
                   ELSE 'bank'
                 END,
                 source.cheque_status,
                 source.cheque_no
               )
        RETURNING cfe.id
      `);

      summary.push(`${source.table}: ${repaired.rowCount} status repairs, ${normalized.rowCount} normalized, ${mirrors.rowCount} mirrors`);
    }

    await client.query(`DROP TRIGGER IF EXISTS trg_ab_registry_linked_cheque_source ON plot_registry_payments`);
    await client.query(`
      CREATE TRIGGER trg_ab_registry_linked_cheque_source
      BEFORE INSERT OR UPDATE ON plot_registry_payments
      FOR EACH ROW EXECUTE FUNCTION enforce_linked_registry_cheque_source()
    `);

    await client.query(`DROP TRIGGER IF EXISTS trg_zx_plot_payment_registry_cheque ON plot_payments`);
    await client.query(`
      CREATE TRIGGER trg_zx_plot_payment_registry_cheque
      AFTER INSERT OR UPDATE ON plot_payments
      FOR EACH ROW EXECUTE FUNCTION sync_plot_payment_registry_cheque()
    `);

    const linkedRegistry = await client.query(`
      UPDATE plot_registry_payments prp
         SET payment_mode = pp.payment_type,
             cheque_status = pp.cheque_status,
             cheque_no = pp.cheque_no,
             updated_at = NOW()
        FROM plot_payments pp
       WHERE prp.source_plot_payment_id = pp.id
         AND (prp.payment_mode, prp.cheque_status, prp.cheque_no)
             IS DISTINCT FROM (pp.payment_type, pp.cheque_status, pp.cheque_no)
      RETURNING prp.id
    `);

    const directCashFlow = await client.query(
      `UPDATE cash_flow_entries
          SET cheque_status = CASE
                WHEN date < $1::date THEN 'CLEARED'
                ELSE 'PENDING'
              END
        WHERE source_module IS NULL
          AND UPPER(TRIM(COALESCE(cash_type, ''))) IN ('CHEQUE', 'CHECK')
          AND UPPER(TRIM(COALESCE(cheque_status, ''))) NOT IN (${VALID_STATUSES})
      RETURNING id`,
      [POLICY_START],
    );

    const normalizedCashFlow = await client.query(`
      UPDATE cash_flow_entries
         SET cheque_status = CASE
               WHEN UPPER(TRIM(COALESCE(cheque_status, ''))) IN (${VALID_STATUSES})
                 THEN UPPER(TRIM(cheque_status))
               ELSE NULL
             END,
             cheque_no = NULLIF(TRIM(COALESCE(cheque_no, '')), '')
       WHERE (
               cheque_status IS NOT NULL
               AND cheque_status IS DISTINCT FROM CASE
                     WHEN UPPER(TRIM(COALESCE(cheque_status, ''))) IN (${VALID_STATUSES})
                       THEN UPPER(TRIM(cheque_status))
                     ELSE NULL
                   END
             )
          OR (
               cheque_no IS NOT NULL
               AND cheque_no IS DISTINCT FROM NULLIF(TRIM(COALESCE(cheque_no, '')), '')
             )
      RETURNING id
    `);

    await client.query(`ALTER TABLE cash_flow_entries DROP CONSTRAINT IF EXISTS cash_flow_entries_cheque_status_valid`);
    await client.query(`
      ALTER TABLE cash_flow_entries
      ADD CONSTRAINT cash_flow_entries_cheque_status_valid
      CHECK (cheque_status IS NULL OR cheque_status IN (${VALID_STATUSES}))
    `);
    await client.query(`ALTER TABLE cash_flow_entries DROP CONSTRAINT IF EXISTS cash_flow_entries_cheque_requires_status`);
    await client.query(`
      ALTER TABLE cash_flow_entries
      ADD CONSTRAINT cash_flow_entries_cheque_requires_status
      CHECK (
        UPPER(TRIM(COALESCE(cash_type, ''))) NOT IN ('CHEQUE', 'CHECK')
        OR cheque_status IS NOT NULL
      )
    `);

    await client.query(`
      INSERT INTO app_schema_migrations (version)
      VALUES ('134_pending_cheque_invariants')
      ON CONFLICT (version) DO NOTHING
    `);
    await client.query('COMMIT');
    console.log(`Migration 134: ${summary.join('; ')}; linked registry: ${linkedRegistry.rowCount} synchronized; direct cash flow: ${directCashFlow.rowCount} status repairs, ${normalizedCashFlow.rowCount} normalized`);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

up()
  .catch((error) => { console.error('Migration 134 failed:', error.message); process.exitCode = 1; })
  .finally(() => pool.end());
