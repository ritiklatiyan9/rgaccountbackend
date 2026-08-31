import 'dotenv/config';
import pool from '../config/db.js';

/**
 * Migration 125 — universal, transaction-safe imprest enforcement.
 *
 * Every canonical money-out row owns exactly one source-qualified imprest
 * debit. Pending/waiting/uncleared rows reserve the money immediately so two
 * pending expenses cannot spend the same float without pretending that the
 * accounting debit has posted. Rejection, cancellation, bounce or deletion
 * releases a reservation or creates/updates the matching restoring ADJUSTMENT. PostgreSQL owns
 * the invariant so normal forms, nested pages, bulk operations, edit requests,
 * cheque transitions, cascades and recycle-bin restores all behave alike.
 *
 * cash_flow_entries and day_book contain many presentation mirrors. The
 * source-table trigger below deliberately charges canonical owner rows only;
 * direct personal-ledger rows are the sole chargeable cash_flow_entries rows.
 * Explicit non-expense projections: imprest, imprest_request,
 * document_imprest, plot_registry_payment, plot_installment_payment,
 * land_deal_payment and every *_person mirror.
 */
const migrate = async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('125_universal_imprest_enforcement'))`);

    // Migration 124 removed source postings. That made a deleted debit vanish
    // from the audit trail. The universal reconciler keeps the debit and adds a
    // restoring adjustment instead, so the old delete triggers must not race it.
    for (const table of [
      'expenses',
      'farmer_payments',
      'plot_commission_payments',
      'vendor_payments',
      'vendor_inventory_payments',
      'day_book',
    ]) {
      await client.query(`DROP TRIGGER IF EXISTS trg_${table}_delete_imprest ON ${table}`);
    }

    // Classification updates below must not be interpreted by an older copy
    // of the universal trigger while this idempotent migration is upgrading it.
    await client.query(`DROP TRIGGER IF EXISTS trg_zz_universal_imprest_day_book ON day_book`);

    // Generated imprest postings are rebuilt from the canonical source on a
    // recycle-bin restore. Archiving the generated rows themselves allows a
    // negative row to be replayed before the sufficient-balance guard runs.
    await client.query(`DROP TRIGGER IF EXISTS trg_recycle_bin_delete ON imprest_ledger`);

    // Editable Day Book labels are presentation, not ownership. Mark genuine
    // internal imprest audit rows explicitly so relabeling a standalone debit
    // to "FARMER PAYMENT"/"IMPREST" can never release its user's money.
    await client.query(`
      ALTER TABLE day_book
        ADD COLUMN IF NOT EXISTS is_imprest_internal BOOLEAN NOT NULL DEFAULT FALSE,
        ADD COLUMN IF NOT EXISTS is_financial_projection BOOLEAN NOT NULL DEFAULT FALSE
    `);
    await client.query(`DROP TRIGGER IF EXISTS trg_preserve_daybook_financial_projection ON day_book`);
    await client.query(`
      DO $classification$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM public.app_schema_migrations
           WHERE version = '125_daybook_internal_classification_v2'
        ) THEN
          UPDATE day_book
             SET is_imprest_internal = TRUE
           WHERE NOT is_imprest_internal
             AND UPPER(COALESCE(entry_type, '')) = 'IMPREST'
             AND (
               imprest_allocation_id IS NOT NULL
               OR UPPER(COALESCE(particular, '')) LIKE 'IMPREST ALLOCATION TO %'
               OR UPPER(COALESCE(particular, '')) LIKE 'IMPREST EXPENSE:%'
               OR UPPER(COALESCE(particular, '')) LIKE 'OVERDRAFT EXPENSE:%'
               OR UPPER(COALESCE(particular, '')) LIKE 'IMPREST ADJUSTMENT FOR %'
               OR UPPER(COALESCE(particular, '')) LIKE 'IMPREST RETURN FROM %'
             );

          -- Mark rows with live owner links plus narrowly identifiable legacy
          -- mirrors orphaned by ON DELETE SET NULL. The signatures reproduce
          -- server-authored formats and are intentionally separate from the
          -- editable label alone: a newly relabelled standalone row is not
          -- exempt from imprest.
          UPDATE day_book
             SET is_financial_projection = TRUE
           WHERE NOT is_financial_projection
             AND (
               farmer_payment_id IS NOT NULL
               OR commission_id IS NOT NULL
               OR cash_flow_entry_id IS NOT NULL
               OR firm_transaction_id IS NOT NULL
               OR plot_payment_id IS NOT NULL
               OR vendor_payment_id IS NOT NULL
               OR imprest_allocation_id IS NOT NULL
               OR (
                 UPPER(COALESCE(entry_type, '')) = 'VENDOR PAYMENT'
                 AND UPPER(COALESCE(particular, '')) LIKE 'VENDOR PAYMENT - %'
                 AND UPPER(COALESCE(category, '')) = 'VENDOR'
                 AND UPPER(COALESCE(from_entity, '')) = 'COMPANY'
               )
               OR (
                 UPPER(COALESCE(entry_type, '')) = 'FARMER PAYMENT'
                 AND COALESCE(debit, 0) >= 0 AND COALESCE(credit, 0) = 0
                 AND NULLIF(TRIM(to_entity), '') IS NOT NULL
                 AND (
                   (
                     UPPER(COALESCE(particular, '')) LIKE 'FARMER PAYMENT - %'
                     AND NULLIF(TRIM(category), '') IS NULL
                   )
                   OR (
                     UPPER(COALESCE(category, '')) = 'FARMER PAYMENT'
                     AND UPPER(COALESCE(particular, '')) ~ ' - FARMER PAYMENT \\((CASH|BANK)\\)$'
                   )
                 )
               )
               OR (
                 UPPER(COALESCE(entry_type, '')) = 'PLOT COMMISSION'
                 AND UPPER(COALESCE(category, '')) = 'COMMISSION'
                 AND UPPER(COALESCE(particular, '')) ~ '\\(PLOT: [^)]+\\) - (COMMISSION|COMMISSION RECEIVED)$'
               )
             );

          UPDATE recycle_bin_entries
             SET row_data = row_data || '{"is_imprest_internal": true}'::jsonb
           WHERE source_table = 'day_book'
             AND UPPER(COALESCE(row_data->>'entry_type', '')) = 'IMPREST'
             AND (
               NULLIF(row_data->>'imprest_allocation_id', '') IS NOT NULL
               OR UPPER(COALESCE(row_data->>'particular', '')) LIKE 'IMPREST ALLOCATION TO %'
               OR UPPER(COALESCE(row_data->>'particular', '')) LIKE 'IMPREST EXPENSE:%'
               OR UPPER(COALESCE(row_data->>'particular', '')) LIKE 'OVERDRAFT EXPENSE:%'
               OR UPPER(COALESCE(row_data->>'particular', '')) LIKE 'IMPREST ADJUSTMENT FOR %'
               OR UPPER(COALESCE(row_data->>'particular', '')) LIKE 'IMPREST RETURN FROM %'
             );

          UPDATE recycle_bin_entries
             SET row_data = row_data || '{"is_financial_projection": true}'::jsonb
           WHERE source_table = 'day_book'
             AND (
               NULLIF(row_data->>'farmer_payment_id', '') IS NOT NULL
               OR NULLIF(row_data->>'commission_id', '') IS NOT NULL
               OR NULLIF(row_data->>'cash_flow_entry_id', '') IS NOT NULL
               OR NULLIF(row_data->>'firm_transaction_id', '') IS NOT NULL
               OR NULLIF(row_data->>'plot_payment_id', '') IS NOT NULL
               OR NULLIF(row_data->>'vendor_payment_id', '') IS NOT NULL
               OR NULLIF(row_data->>'imprest_allocation_id', '') IS NOT NULL
               OR (
                 UPPER(COALESCE(row_data->>'entry_type', '')) = 'VENDOR PAYMENT'
                 AND UPPER(COALESCE(row_data->>'particular', '')) LIKE 'VENDOR PAYMENT - %'
                 AND UPPER(COALESCE(row_data->>'category', '')) = 'VENDOR'
                 AND UPPER(COALESCE(row_data->>'from_entity', '')) = 'COMPANY'
               )
               OR (
                 UPPER(COALESCE(row_data->>'entry_type', '')) = 'FARMER PAYMENT'
                 AND COALESCE(NULLIF(row_data->>'debit', '')::numeric, 0) >= 0
                 AND COALESCE(NULLIF(row_data->>'credit', '')::numeric, 0) = 0
                 AND NULLIF(TRIM(row_data->>'to_entity'), '') IS NOT NULL
                 AND (
                   (
                     UPPER(COALESCE(row_data->>'particular', '')) LIKE 'FARMER PAYMENT - %'
                     AND NULLIF(TRIM(row_data->>'category'), '') IS NULL
                   )
                   OR (
                     UPPER(COALESCE(row_data->>'category', '')) = 'FARMER PAYMENT'
                     AND UPPER(COALESCE(row_data->>'particular', '')) ~ ' - FARMER PAYMENT \\((CASH|BANK)\\)$'
                   )
                 )
               )
               OR (
                 UPPER(COALESCE(row_data->>'entry_type', '')) = 'PLOT COMMISSION'
                 AND UPPER(COALESCE(row_data->>'category', '')) = 'COMMISSION'
                 AND UPPER(COALESCE(row_data->>'particular', '')) ~ '\\(PLOT: [^)]+\\) - (COMMISSION|COMMISSION RECEIVED)$'
               )
             );

          INSERT INTO public.app_schema_migrations(version)
          VALUES ('125_daybook_internal_classification_v2')
          ON CONFLICT (version) DO NOTHING;
        END IF;

        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
           WHERE conname = 'day_book_imprest_internal_type_check'
             AND conrelid = 'day_book'::regclass
        ) THEN
          ALTER TABLE day_book
            ADD CONSTRAINT day_book_imprest_internal_type_check
            CHECK (
              NOT is_imprest_internal
              OR UPPER(COALESCE(entry_type, '')) = 'IMPREST'
            );
        END IF;
      END
      $classification$
    `);

    await client.query(`
      CREATE OR REPLACE FUNCTION preserve_daybook_financial_projection()
      RETURNS TRIGGER
      LANGUAGE plpgsql
      AS $$
      BEGIN
        -- Provenance is server-owned. A caller cannot exempt an arbitrary
        -- standalone debit by submitting is_financial_projection=true. New
        -- mirrors are marked only from a real owner FK; updates also retain a
        -- prior marker or an OLD owner FK that ON DELETE SET NULL is clearing.
        IF TG_OP = 'INSERT' THEN
          NEW.is_financial_projection :=
               NEW.farmer_payment_id IS NOT NULL
            OR NEW.commission_id IS NOT NULL
            OR NEW.cash_flow_entry_id IS NOT NULL
            OR NEW.firm_transaction_id IS NOT NULL
            OR NEW.plot_payment_id IS NOT NULL
            OR NEW.vendor_payment_id IS NOT NULL
            OR NEW.imprest_allocation_id IS NOT NULL;
        ELSE
          NEW.is_financial_projection := COALESCE(OLD.is_financial_projection, FALSE)
            OR OLD.farmer_payment_id IS NOT NULL
            OR OLD.commission_id IS NOT NULL
            OR OLD.cash_flow_entry_id IS NOT NULL
            OR OLD.firm_transaction_id IS NOT NULL
            OR OLD.plot_payment_id IS NOT NULL
            OR OLD.vendor_payment_id IS NOT NULL
            OR OLD.imprest_allocation_id IS NOT NULL
            OR NEW.farmer_payment_id IS NOT NULL
            OR NEW.commission_id IS NOT NULL
            OR NEW.cash_flow_entry_id IS NOT NULL
            OR NEW.firm_transaction_id IS NOT NULL
            OR NEW.plot_payment_id IS NOT NULL
            OR NEW.vendor_payment_id IS NOT NULL
            OR NEW.imprest_allocation_id IS NOT NULL;
        END IF;
        RETURN NEW;
      END
      $$
    `);
    await client.query(`
      CREATE TRIGGER trg_preserve_daybook_financial_projection
      BEFORE INSERT OR UPDATE ON day_book
      FOR EACH ROW EXECUTE FUNCTION preserve_daybook_financial_projection()
    `);

    // Reservations reduce the user's AVAILABLE imprest without changing the
    // posted ledger balance used by Site Balance. They become a real EXPENSE
    // ledger row only when the source debit is approved (and a cheque clears).
    await client.query(`
      CREATE TABLE IF NOT EXISTS imprest_debit_reservations (
        source_module VARCHAR(50) NOT NULL,
        reference_id  INTEGER NOT NULL,
        user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        site_id       INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
        amount        NUMERIC(15,2) NOT NULL CHECK (amount > 0),
        remarks       TEXT,
        proof_key     TEXT,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (source_module, reference_id)
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_imprest_debit_reservations_account
        ON imprest_debit_reservations(user_id, site_id)
    `);
    await client.query(`DROP TRIGGER IF EXISTS trg_recycle_bin_delete ON imprest_debit_reservations`);

    await client.query(`
      CREATE OR REPLACE FUNCTION refresh_imprest_balance_snapshots(
        p_user_id INTEGER,
        p_site_id INTEGER
      ) RETURNS VOID
      LANGUAGE plpgsql
      AS $$
      BEGIN
        WITH ordered AS (
          SELECT il.id,
                 SUM(il.amount) OVER (
                   ORDER BY il.created_at, il.id
                   ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
                 ) AS running_balance
            FROM imprest_ledger il
           WHERE il.user_id = p_user_id
             AND il.site_id IS NOT DISTINCT FROM p_site_id
        )
        UPDATE imprest_ledger il
           SET balance_after = ordered.running_balance
          FROM ordered
         WHERE il.id = ordered.id
           AND il.balance_after IS DISTINCT FROM ordered.running_balance;
      END
      $$
    `);

    await client.query(`
      CREATE OR REPLACE FUNCTION imprest_debit_is_active(
        p_status TEXT,
        p_cheque_status TEXT,
        p_deleted_at TEXT DEFAULT NULL
      ) RETURNS BOOLEAN
      LANGUAGE SQL
      IMMUTABLE
      PARALLEL SAFE
      AS $$
        SELECT p_deleted_at IS NULL
          AND LOWER(COALESCE(NULLIF(TRIM(p_status), ''), 'pending'))
                NOT IN ('rejected', 'returned', 'cancelled', 'deleted', 'void', 'voided')
          AND UPPER(COALESCE(TRIM(p_cheque_status), ''))
                NOT IN ('BOUNCED', 'RETURNED')
      $$
    `);

    await client.query(`
      CREATE OR REPLACE FUNCTION reconcile_imprest_debit(
        p_source_module TEXT,
        p_reference_id INTEGER,
        p_user_id INTEGER,
        p_site_id INTEGER,
        p_amount NUMERIC,
        p_active BOOLEAN,
        p_posted BOOLEAN,
        p_remarks TEXT DEFAULT NULL,
        p_proof_key TEXT DEFAULT NULL
      ) RETURNS VOID
      LANGUAGE plpgsql
      AS $$
      DECLARE
        v_required NUMERIC(15,2) := CASE
          WHEN COALESCE(p_active, FALSE) THEN ROUND(GREATEST(COALESCE(p_amount, 0), 0), 2)
          ELSE 0
        END;
        v_wants_posted BOOLEAN := v_required > 0 AND COALESCE(p_posted, FALSE);
        v_group RECORD;
        v_lock_user INTEGER;
        v_user_exists BOOLEAN;
        v_current NUMERIC(15,2);
        v_source_net NUMERIC(15,2);
        v_other_reserved NUMERIC(15,2);
        v_base NUMERIC(15,2);
        v_restore NUMERIC(15,2);
        v_final NUMERIC(15,2);
        v_message TEXT;
      BEGIN
        IF NULLIF(TRIM(p_source_module), '') IS NULL OR p_reference_id IS NULL THEN
          RETURN;
        END IF;

        IF v_required > 0 AND (p_user_id IS NULL OR p_site_id IS NULL) THEN
          RAISE EXCEPTION USING
            ERRCODE = 'P0001',
            CONSTRAINT = 'imprest_debit_owner_required',
            MESSAGE = 'This debit has no valid user and site for imprest. Save it with the logged-in user and a site.';
        END IF;

        -- Every ledger writer in the application locks the user row. Taking
        -- the same locks in stable id order serializes simultaneous debits,
        -- allocations, transfers, returns and adjustments without deadlocks.
        FOR v_lock_user IN
          SELECT DISTINCT q.user_id
            FROM (
              SELECT il.user_id
                FROM imprest_ledger il
               WHERE il.source_module = p_source_module
                 AND il.reference_id = p_reference_id
                 AND il.type IN ('EXPENSE', 'ADJUSTMENT')
              UNION ALL
              SELECT r.user_id
                FROM imprest_debit_reservations r
               WHERE r.source_module = p_source_module
                 AND r.reference_id = p_reference_id
              UNION ALL
              -- Zero-amount mirrors/internal audit rows have no availability
              -- to protect. Locking their creator could invert the normal
              -- admin→recipient lock order used by transfers and deadlock.
              SELECT p_user_id
               WHERE p_user_id IS NOT NULL AND v_required > 0
            ) q
           ORDER BY q.user_id
        LOOP
          PERFORM 1 FROM users WHERE id = v_lock_user FOR UPDATE;
        END LOOP;

        IF v_required > 0 THEN
          SELECT EXISTS(
            SELECT 1 FROM users u
             WHERE u.id = p_user_id AND COALESCE(u.is_active, TRUE)
          ) INTO v_user_exists;
          IF NOT v_user_exists THEN
            RAISE EXCEPTION USING
              ERRCODE = 'P0001',
              CONSTRAINT = 'imprest_debit_owner_required',
              MESSAGE = 'The user responsible for this debit is inactive or missing.';
          END IF;
        END IF;

        -- Restore every previous owner/site posting except the one that will
        -- remain active below. This also makes creator/site moves atomic.
        FOR v_group IN
          SELECT il.user_id,
                 il.site_id,
                 COALESCE(SUM(il.amount) FILTER (WHERE il.type = 'EXPENSE'), 0)::numeric AS expense_total
            FROM imprest_ledger il
           WHERE il.source_module = p_source_module
             AND il.reference_id = p_reference_id
             AND il.type IN ('EXPENSE', 'ADJUSTMENT')
           GROUP BY il.user_id, il.site_id
           ORDER BY il.user_id, il.site_id
        LOOP
          IF v_wants_posted
             AND v_group.user_id = p_user_id
             AND v_group.site_id IS NOT DISTINCT FROM p_site_id THEN
            CONTINUE;
          END IF;

          v_restore := ROUND(GREATEST(-v_group.expense_total, 0), 2);
          IF v_restore <= 0 THEN
            CONTINUE;
          END IF;

          SELECT COALESCE(SUM(il.amount), 0)::numeric
            INTO v_current
            FROM imprest_ledger il
           WHERE il.user_id = v_group.user_id
             AND il.site_id IS NOT DISTINCT FROM v_group.site_id;

          SELECT COALESCE(SUM(il.amount), 0)::numeric
            INTO v_source_net
            FROM imprest_ledger il
           WHERE il.user_id = v_group.user_id
             AND il.site_id IS NOT DISTINCT FROM v_group.site_id
             AND il.source_module = p_source_module
             AND il.reference_id = p_reference_id
             AND il.type IN ('EXPENSE', 'ADJUSTMENT');

          v_final := v_current - v_source_net;
          INSERT INTO imprest_ledger (
            user_id, type, reference_id, amount, balance_after, remarks,
            created_by, site_id, source_module
          ) VALUES (
            v_group.user_id, 'ADJUSTMENT', p_reference_id, v_restore, v_final,
            UPPER('AUTO RESTORED — DEBIT REMOVED OR INACTIVE: '
              || COALESCE(NULLIF(TRIM(p_remarks), ''), p_source_module || ' #' || p_reference_id)),
            p_user_id, v_group.site_id, p_source_module
          )
          ON CONFLICT (user_id, site_id, source_module, reference_id, type)
            WHERE source_module IS NOT NULL
          DO UPDATE SET
            amount = EXCLUDED.amount,
            balance_after = EXCLUDED.balance_after,
            remarks = EXCLUDED.remarks,
            created_by = COALESCE(EXCLUDED.created_by, imprest_ledger.created_by),
            created_at = CASE
              WHEN imprest_ledger.amount IS DISTINCT FROM EXCLUDED.amount THEN NOW()
              ELSE imprest_ledger.created_at
            END;

          PERFORM refresh_imprest_balance_snapshots(v_group.user_id, v_group.site_id);
        END LOOP;

        -- A source can own at most one reservation. Moving owner/site, posting,
        -- rejecting or deleting it releases the previous hold atomically.
        DELETE FROM imprest_debit_reservations r
         WHERE r.source_module = p_source_module
           AND r.reference_id = p_reference_id
           AND (
             v_required <= 0
             OR v_wants_posted
             OR r.user_id IS DISTINCT FROM p_user_id
             OR r.site_id IS DISTINCT FROM p_site_id
           );

        IF v_required <= 0 THEN
          RETURN;
        END IF;

        SELECT COALESCE(SUM(il.amount), 0)::numeric
          INTO v_current
          FROM imprest_ledger il
         WHERE il.user_id = p_user_id AND il.site_id = p_site_id;

        SELECT COALESCE(SUM(il.amount), 0)::numeric
          INTO v_source_net
          FROM imprest_ledger il
         WHERE il.user_id = p_user_id
           AND il.site_id = p_site_id
           AND il.source_module = p_source_module
           AND il.reference_id = p_reference_id
           AND il.type IN ('EXPENSE', 'ADJUSTMENT');

        SELECT COALESCE(SUM(r.amount), 0)::numeric
          INTO v_other_reserved
          FROM imprest_debit_reservations r
         WHERE r.user_id = p_user_id
           AND r.site_id = p_site_id
           AND NOT (
             r.source_module = p_source_module
             AND r.reference_id = p_reference_id
           );

        -- Remove this source's current posted net effect and reservation before
        -- testing its desired amount. Retries and edits apply the exact delta,
        -- while unrelated pending debits remain unavailable.
        v_base := v_current - v_source_net - v_other_reserved;
        -- API middleware exposes this constraint as INSUFFICIENT_IMPREST (409).
        IF v_base + 0.005 < v_required THEN
          v_message := format(
            'Insufficient imprest balance. Available: ₹%s, required: ₹%s. Add imprest before recording this debit.',
            to_char(v_base, 'FM999999999990.00'),
            to_char(v_required, 'FM999999999990.00')
          );
          RAISE EXCEPTION USING
            ERRCODE = 'P0001',
            CONSTRAINT = 'imprest_sufficient_balance',
            MESSAGE = v_message,
            DETAIL = jsonb_build_object(
              'available', v_base,
              'required', v_required,
              'shortfall', ROUND(v_required - GREATEST(v_base, 0), 2),
              'user_id', p_user_id,
              'site_id', p_site_id,
              'source_module', p_source_module,
              'reference_id', p_reference_id
            )::text;
        END IF;

        IF NOT v_wants_posted THEN
          INSERT INTO imprest_debit_reservations (
            source_module, reference_id, user_id, site_id, amount,
            remarks, proof_key
          ) VALUES (
            p_source_module, p_reference_id, p_user_id, p_site_id, v_required,
            UPPER(COALESCE(NULLIF(TRIM(p_remarks), ''), p_source_module || ' #' || p_reference_id)),
            p_proof_key
          )
          ON CONFLICT (source_module, reference_id) DO UPDATE SET
            user_id = EXCLUDED.user_id,
            site_id = EXCLUDED.site_id,
            amount = EXCLUDED.amount,
            remarks = EXCLUDED.remarks,
            proof_key = COALESCE(EXCLUDED.proof_key, imprest_debit_reservations.proof_key),
            updated_at = CASE
              WHEN (imprest_debit_reservations.user_id,
                    imprest_debit_reservations.site_id,
                    imprest_debit_reservations.amount)
                   IS DISTINCT FROM
                   (EXCLUDED.user_id, EXCLUDED.site_id, EXCLUDED.amount)
                THEN NOW()
              ELSE imprest_debit_reservations.updated_at
            END;
          RETURN;
        END IF;

        v_final := v_base - v_required;
        INSERT INTO imprest_ledger (
          user_id, type, reference_id, amount, balance_after, remarks,
          created_by, site_id, source_module, proof_key
        ) VALUES (
          p_user_id, 'EXPENSE', p_reference_id, -v_required, v_final,
          UPPER('AUTO IMPREST DEBIT: '
            || COALESCE(NULLIF(TRIM(p_remarks), ''), p_source_module || ' #' || p_reference_id)),
          p_user_id, p_site_id, p_source_module, p_proof_key
        )
        ON CONFLICT (user_id, site_id, source_module, reference_id, type)
          WHERE source_module IS NOT NULL
        DO UPDATE SET
          amount = EXCLUDED.amount,
          balance_after = EXCLUDED.balance_after,
          remarks = EXCLUDED.remarks,
          proof_key = COALESCE(EXCLUDED.proof_key, imprest_ledger.proof_key),
          created_at = CASE
            WHEN imprest_ledger.amount IS DISTINCT FROM EXCLUDED.amount THEN NOW()
            ELSE imprest_ledger.created_at
          END;

        -- A rejected/deleted source has an offsetting ADJUSTMENT. Reactivation
        -- consumes that restoration without deleting audit-owned rows.
        UPDATE imprest_ledger
           SET amount = 0,
               balance_after = v_final,
               remarks = UPPER('RESTORATION CONSUMED — DEBIT ACTIVE: '
                 || COALESCE(NULLIF(TRIM(p_remarks), ''), p_source_module || ' #' || p_reference_id)),
               created_at = CASE WHEN amount <> 0 THEN NOW() ELSE created_at END
         WHERE user_id = p_user_id
           AND site_id = p_site_id
           AND source_module = p_source_module
           AND reference_id = p_reference_id
           AND type = 'ADJUSTMENT'
           AND amount IS DISTINCT FROM 0::numeric;

        PERFORM refresh_imprest_balance_snapshots(p_user_id, p_site_id);
      END
      $$
    `);

    await client.query(`
      CREATE OR REPLACE FUNCTION reconcile_direct_cashflow_imprest(p_entry_id INTEGER)
      RETURNS VOID
      LANGUAGE plpgsql
      AS $$
      DECLARE
        v_entry RECORD;
        v_is_firm_mirror BOOLEAN;
        v_amount NUMERIC;
        v_active BOOLEAN;
      BEGIN
        SELECT * INTO v_entry FROM cash_flow_entries WHERE id = p_entry_id;
        IF NOT FOUND THEN
          PERFORM reconcile_imprest_debit(
            'cash_flow_entry', p_entry_id, NULL, NULL, 0, FALSE,
            FALSE, 'PERSONAL LEDGER ENTRY DELETED', NULL
          );
          RETURN;
        END IF;

        SELECT EXISTS(
          SELECT 1 FROM firm_transactions ft WHERE ft.cash_flow_entry_id = p_entry_id
        ) INTO v_is_firm_mirror;

        -- All non-NULL source modules are generated projections (_person,
        -- plot_registry_payments, imprest/document_imprest and ordinary module
        -- mirrors included). Only a true direct Personal Ledger row is owned
        -- here, and a direct row linked from a firm transaction is its mirror.
        IF v_entry.source_module IS NOT NULL OR v_is_firm_mirror THEN
          PERFORM reconcile_imprest_debit(
            'cash_flow_entry', p_entry_id, v_entry.created_by, v_entry.site_id,
            0, FALSE, FALSE, 'DERIVED CASH-FLOW MIRROR', NULL
          );
          RETURN;
        END IF;

        v_amount := GREATEST(COALESCE(v_entry.debit, 0), 0)
                  + GREATEST(-COALESCE(v_entry.credit, 0), 0);
        v_active := imprest_debit_is_active(v_entry.status, v_entry.cheque_status);
        PERFORM reconcile_imprest_debit(
          'cash_flow_entry', v_entry.id, v_entry.created_by, v_entry.site_id,
          v_amount,
          v_active,
          v_active AND financial_transaction_posts(
            'debit', v_entry.status, v_entry.cash_type, v_entry.cheque_status
          ),
          COALESCE(v_entry.particular, 'PERSONAL LEDGER ENTRY'),
          v_entry.voucher_url
        );
      END
      $$
    `);

    await client.query(`
      CREATE OR REPLACE FUNCTION sync_universal_imprest_from_source()
      RETURNS TRIGGER
      LANGUAGE plpgsql
      AS $$
      DECLARE
        v_row JSONB := CASE WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
        v_old JSONB := CASE WHEN TG_OP IN ('UPDATE', 'DELETE') THEN to_jsonb(OLD) ELSE '{}'::jsonb END;
        v_source_module TEXT;
        v_reference_id INTEGER;
        v_user_id INTEGER;
        v_site_id INTEGER;
        v_amount NUMERIC := 0;
        v_active BOOLEAN := FALSE;
        v_posted BOOLEAN := FALSE;
        v_payment_mode TEXT;
        v_remarks TEXT;
        v_proof_key TEXT;
        v_entry_type TEXT;
        v_linked BOOLEAN := FALSE;
        v_new_cashflow_id INTEGER;
        v_old_cashflow_id INTEGER;
      BEGIN
        v_reference_id := NULLIF(v_row->>'id', '')::integer;

        IF TG_TABLE_NAME = 'cash_flow_entries' THEN
          IF TG_OP = 'DELETE' THEN
            PERFORM reconcile_imprest_debit(
              'cash_flow_entry', v_reference_id, NULL, NULL, 0, FALSE,
              FALSE, 'PERSONAL LEDGER ENTRY DELETED', NULL
            );
          ELSE
            PERFORM reconcile_direct_cashflow_imprest(v_reference_id);
          END IF;
          IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
          RETURN NEW;
        END IF;

        IF TG_TABLE_NAME = 'expenses' THEN
          v_source_module := 'expense';
          v_user_id := NULLIF(v_row->>'created_by', '')::integer;
          v_site_id := NULLIF(v_row->>'site_id', '')::integer;
          v_amount := GREATEST(COALESCE(NULLIF(v_row->>'debit', '')::numeric, 0), 0)
                    + GREATEST(-COALESCE(NULLIF(v_row->>'credit', '')::numeric, 0), 0);
          v_remarks := COALESCE(v_row->>'remark', 'EXPENSE');
          v_proof_key := COALESCE(v_row->>'imprest_proof_key', v_row->>'voucher_url');

        ELSIF TG_TABLE_NAME = 'farmer_payments' THEN
          v_source_module := 'farmer_payment';
          v_user_id := NULLIF(v_row->>'created_by', '')::integer;
          SELECT f.site_id INTO v_site_id
            FROM farmers f
           WHERE f.id = NULLIF(v_row->>'farmer_id', '')::integer;
          IF v_site_id IS NULL THEN
            SELECT cfe.site_id INTO v_site_id
              FROM cash_flow_entries cfe
             WHERE cfe.source_module = 'farmer_payments'
               AND cfe.source_id = v_reference_id
             LIMIT 1;
          END IF;
          IF v_user_id IS NULL THEN
            SELECT COALESCE(
              (
                SELECT cfe.created_by
                  FROM cash_flow_entries cfe
                 WHERE cfe.source_module = 'farmer_payments'
                   AND cfe.source_id = v_reference_id
                   AND cfe.created_by IS NOT NULL
                 ORDER BY cfe.id
                 LIMIT 1
              ),
              (
                SELECT db.created_by
                  FROM day_book db
                 WHERE db.farmer_payment_id = v_reference_id
                   AND db.created_by IS NOT NULL
                 ORDER BY db.id
                 LIMIT 1
              )
            ) INTO v_user_id;
          END IF;
          -- SPLIT payments are rendered as independent cash and bank ledger
          -- legs. Charge their actual positive legs, not the editable summary
          -- amount, so a mismatched total cannot understate the outflow.
          IF UPPER(COALESCE(v_row->>'payment_mode', '')) = 'SPLIT' THEN
            v_amount := GREATEST(COALESCE(NULLIF(v_row->>'cash_amount', '')::numeric, 0), 0)
                      + GREATEST(COALESCE(NULLIF(v_row->>'bank_amount', '')::numeric, 0), 0);
          ELSE
            v_amount := GREATEST(COALESCE(NULLIF(v_row->>'amount', '')::numeric, 0), 0);
          END IF;
          v_remarks := COALESCE(v_row->>'remarks', 'FARMER PAYMENT');
          v_proof_key := v_row->>'voucher_url';

        ELSIF TG_TABLE_NAME = 'plot_commissions' THEN
          v_source_module := 'plot_commission';
          v_user_id := NULLIF(v_row->>'created_by', '')::integer;
          v_site_id := NULLIF(v_row->>'site_id', '')::integer;
          v_amount := GREATEST(COALESCE(NULLIF(v_row->>'amount', '')::numeric, 0), 0);
          v_remarks := COALESCE(v_row->>'particular', 'PLOT COMMISSION');
          v_proof_key := v_row->>'voucher_url';

        ELSIF TG_TABLE_NAME = 'plot_commission_payments' THEN
          v_source_module := 'plot_commission_payment';
          v_user_id := NULLIF(v_row->>'created_by', '')::integer;
          v_site_id := NULLIF(v_row->>'site_id', '')::integer;
          v_amount := GREATEST(COALESCE(NULLIF(v_row->>'amount', '')::numeric, 0), 0);
          v_remarks := COALESCE(v_row->>'remarks', 'PLOT COMMISSION PAYMENT');
          v_proof_key := v_row->>'voucher_url';

        ELSIF TG_TABLE_NAME = 'vendor_payments' THEN
          v_source_module := 'vendor_payment';
          v_user_id := NULLIF(v_row->>'created_by', '')::integer;
          v_site_id := NULLIF(v_row->>'site_id', '')::integer;
          v_amount := GREATEST(COALESCE(NULLIF(v_row->>'amount', '')::numeric, 0), 0);
          v_remarks := COALESCE(v_row->>'note', 'VENDOR PAYMENT');
          v_proof_key := v_row->>'voucher_url';

        ELSIF TG_TABLE_NAME = 'vendor_inventory_payments' THEN
          v_source_module := 'vendor_inventory_payment';
          v_user_id := NULLIF(v_row->>'created_by', '')::integer;
          v_site_id := NULLIF(v_row->>'site_id', '')::integer;
          -- A linked inventory row only allocates an already-owned vendor
          -- payment; charging it would debit the same spend twice.
          IF NULLIF(v_row->>'source_vendor_payment_id', '') IS NULL THEN
            v_amount := GREATEST(COALESCE(NULLIF(v_row->>'amount', '')::numeric, 0), 0);
          END IF;
          v_remarks := COALESCE(v_row->>'note', 'VENDOR INVENTORY PAYMENT');
          v_proof_key := v_row->>'voucher_url';

        ELSIF TG_TABLE_NAME = 'firm_transactions' THEN
          v_source_module := 'firm_transaction';
          v_user_id := NULLIF(v_row->>'created_by', '')::integer;
          v_site_id := NULLIF(v_row->>'site_id', '')::integer;
          v_amount := GREATEST(COALESCE(NULLIF(v_row->>'debit', '')::numeric, 0), 0)
                    + GREATEST(-COALESCE(NULLIF(v_row->>'credit', '')::numeric, 0), 0);
          v_remarks := COALESCE(v_row->>'description', 'FIRM TRANSACTION');
          v_proof_key := v_row->>'voucher_url';
          v_new_cashflow_id := CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE NULLIF(v_row->>'cash_flow_entry_id', '')::integer END;
          v_old_cashflow_id := CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE NULLIF(v_old->>'cash_flow_entry_id', '')::integer END;

          -- Firm create first writes a direct CFE and then links it. Release
          -- that temporary owner before charging the canonical firm row.
          IF v_new_cashflow_id IS NOT NULL THEN
            PERFORM reconcile_imprest_debit(
              'cash_flow_entry', v_new_cashflow_id, NULL, NULL, 0, FALSE,
              FALSE, 'LINKED FIRM CASH-FLOW MIRROR', NULL
            );
          END IF;

          v_active := TG_OP <> 'DELETE'
            AND imprest_debit_is_active(v_row->>'status', v_row->>'cheque_status', v_row->>'deleted_at');
          v_posted := v_active AND financial_transaction_posts(
            'debit', v_row->>'status', v_row->>'payment_mode', v_row->>'cheque_status'
          );
          PERFORM reconcile_imprest_debit(
            v_source_module, v_reference_id, v_user_id, v_site_id, v_amount,
            v_active, v_posted, v_remarks, v_proof_key
          );

          -- If an edit/delete unlinks the old direct row, it becomes canonical
          -- again. Reconcile after releasing the firm posting to avoid a false
          -- temporary insufficient-balance failure.
          IF v_old_cashflow_id IS NOT NULL
             AND v_old_cashflow_id IS DISTINCT FROM v_new_cashflow_id THEN
            PERFORM reconcile_direct_cashflow_imprest(v_old_cashflow_id);
          END IF;
          IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
          RETURN NEW;

        ELSIF TG_TABLE_NAME = 'misc_income_entries' THEN
          v_source_module := 'misc_income_entry';
          v_user_id := NULLIF(v_row->>'created_by', '')::integer;
          v_site_id := NULLIF(v_row->>'site_id', '')::integer;
          IF LOWER(COALESCE(v_row->>'direction', 'credit')) = 'debit' THEN
            v_amount := GREATEST(COALESCE(NULLIF(v_row->>'amount', '')::numeric, 0), 0);
          END IF;
          v_remarks := COALESCE(v_row->>'remarks', 'MISC INCOME REFUND');
          v_proof_key := v_row->>'voucher_url';

        ELSIF TG_TABLE_NAME = 'plot_payments' THEN
          v_source_module := 'plot_payment';
          v_user_id := NULLIF(v_row->>'created_by', '')::integer;
          v_site_id := NULLIF(v_row->>'site_id', '')::integer;
          -- Plot payments are receipts; a negative receipt is the refund edge
          -- and therefore an outflow owned by the creator's imprest.
          v_amount := GREATEST(-COALESCE(NULLIF(v_row->>'amount', '')::numeric, 0), 0);
          v_remarks := COALESCE(v_row->>'narration', 'PLOT PAYMENT REFUND');
          v_proof_key := v_row->>'voucher_url';

        ELSIF TG_TABLE_NAME = 'day_book' THEN
          v_source_module := 'daybook';
          v_user_id := NULLIF(v_row->>'created_by', '')::integer;
          v_site_id := NULLIF(v_row->>'site_id', '')::integer;
          v_entry_type := UPPER(COALESCE(v_row->>'entry_type', 'GENERAL'));
          v_linked := COALESCE(NULLIF(v_row->>'is_financial_projection', '')::boolean, FALSE)
            OR NULLIF(v_row->>'farmer_payment_id', '') IS NOT NULL
            OR NULLIF(v_row->>'commission_id', '') IS NOT NULL
            OR NULLIF(v_row->>'cash_flow_entry_id', '') IS NOT NULL
            OR NULLIF(v_row->>'firm_transaction_id', '') IS NOT NULL
            OR NULLIF(v_row->>'plot_payment_id', '') IS NOT NULL
            OR NULLIF(v_row->>'vendor_payment_id', '') IS NOT NULL
            OR NULLIF(v_row->>'imprest_allocation_id', '') IS NOT NULL
            OR (
              v_entry_type = 'IMPREST'
              AND COALESCE(NULLIF(v_row->>'is_imprest_internal', '')::boolean, FALSE)
            );
          IF NOT v_linked THEN
            v_amount := GREATEST(COALESCE(NULLIF(v_row->>'debit', '')::numeric, 0), 0)
                      + GREATEST(-COALESCE(NULLIF(v_row->>'credit', '')::numeric, 0), 0);
          END IF;
          v_remarks := COALESCE(v_row->>'particular', 'DAY BOOK ENTRY');
          v_proof_key := v_row->>'voucher_url';

        ELSE
          IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
          RETURN NEW;
        END IF;

        v_active := TG_OP <> 'DELETE'
          AND v_amount > 0
          AND imprest_debit_is_active(v_row->>'status', v_row->>'cheque_status', v_row->>'deleted_at');
        v_payment_mode := COALESCE(
          v_row->>'payment_mode', v_row->>'cash_type', v_row->>'payment_type'
        );
        v_posted := v_active AND financial_transaction_posts(
          'debit', v_row->>'status', v_payment_mode, v_row->>'cheque_status'
        );

        PERFORM reconcile_imprest_debit(
          v_source_module, v_reference_id, v_user_id, v_site_id,
          v_amount, v_active, v_posted, v_remarks, v_proof_key
        );
        IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
        RETURN NEW;
      END
      $$
    `);

    const sources = [
      ['expenses', 'expense'],
      ['farmer_payments', 'farmer_payment'],
      ['plot_commissions', 'plot_commission'],
      ['plot_commission_payments', 'plot_commission_payment'],
      ['vendor_payments', 'vendor_payment'],
      ['vendor_inventory_payments', 'vendor_inventory_payment'],
      ['firm_transactions', 'firm_transaction'],
      ['cash_flow_entries', 'cash_flow_entry'],
      ['misc_income_entries', 'misc_income_entry'],
      ['plot_payments', 'plot_payment'],
      ['day_book', 'daybook'],
    ];

    for (const [table] of sources) {
      const trigger = `trg_zz_universal_imprest_${table}`;
      await client.query(`DROP TRIGGER IF EXISTS ${trigger} ON ${table}`);
      await client.query(`
        CREATE TRIGGER ${trigger}
        AFTER INSERT OR UPDATE OR DELETE ON ${table}
        FOR EACH ROW EXECUTE FUNCTION sync_universal_imprest_from_source()
      `);
    }

    // If an earlier version briefly classified a surviving mirror as a direct
    // Day Book debit, release only that source-qualified posting/reservation.
    // Rows without generated imprest state are untouched; this is not a
    // historical business-data backfill.
    await client.query(`
      SELECT reconcile_imprest_debit(
        'daybook', d.id, NULL, NULL, 0, FALSE, FALSE,
        'DERIVED DAY BOOK PROJECTION — IMPREST RESTORED', NULL
      )
        FROM day_book d
       WHERE (d.is_financial_projection OR d.is_imprest_internal)
         AND (
           EXISTS (
             SELECT 1 FROM imprest_ledger il
              WHERE il.source_module = 'daybook' AND il.reference_id = d.id
           )
           OR EXISTS (
             SELECT 1 FROM imprest_debit_reservations r
              WHERE r.source_module = 'daybook' AND r.reference_id = d.id
           )
         )
    `);

    // Repair only generated postings/reservations whose canonical source was
    // already deleted before this migration existed. This is deliberately not
    // a historical debit backfill: old unposted business rows are grandfathered
    // because charging them now could manufacture an unpayable legacy balance.
    // A later recycle-bin restore remains safe—the source INSERT will consume
    // this adjustment (or fail the normal sufficient-balance check).
    await client.query(`
      WITH owned_keys AS (
        SELECT DISTINCT source_module, reference_id
          FROM imprest_ledger
         WHERE source_module IN (
           'expense', 'farmer_payment', 'plot_commission',
           'plot_commission_payment', 'vendor_payment',
           'vendor_inventory_payment', 'firm_transaction',
           'cash_flow_entry', 'misc_income_entry', 'plot_payment', 'daybook'
         )
           AND reference_id IS NOT NULL
           AND type IN ('EXPENSE', 'ADJUSTMENT')
        UNION
        SELECT source_module, reference_id
          FROM imprest_debit_reservations
      ), missing_sources AS (
        SELECT k.* FROM owned_keys k
         WHERE k.source_module = 'expense'
           AND NOT EXISTS (SELECT 1 FROM expenses s WHERE s.id = k.reference_id)
        UNION ALL
        SELECT k.* FROM owned_keys k
         WHERE k.source_module = 'farmer_payment'
           AND NOT EXISTS (SELECT 1 FROM farmer_payments s WHERE s.id = k.reference_id)
        UNION ALL
        SELECT k.* FROM owned_keys k
         WHERE k.source_module = 'plot_commission'
           AND NOT EXISTS (SELECT 1 FROM plot_commissions s WHERE s.id = k.reference_id)
        UNION ALL
        SELECT k.* FROM owned_keys k
         WHERE k.source_module = 'plot_commission_payment'
           AND NOT EXISTS (SELECT 1 FROM plot_commission_payments s WHERE s.id = k.reference_id)
        UNION ALL
        SELECT k.* FROM owned_keys k
         WHERE k.source_module = 'vendor_payment'
           AND NOT EXISTS (SELECT 1 FROM vendor_payments s WHERE s.id = k.reference_id)
        UNION ALL
        SELECT k.* FROM owned_keys k
         WHERE k.source_module = 'vendor_inventory_payment'
           AND NOT EXISTS (SELECT 1 FROM vendor_inventory_payments s WHERE s.id = k.reference_id)
        UNION ALL
        SELECT k.* FROM owned_keys k
         WHERE k.source_module = 'firm_transaction'
           AND NOT EXISTS (SELECT 1 FROM firm_transactions s WHERE s.id = k.reference_id)
        UNION ALL
        SELECT k.* FROM owned_keys k
         WHERE k.source_module = 'cash_flow_entry'
           AND NOT EXISTS (SELECT 1 FROM cash_flow_entries s WHERE s.id = k.reference_id)
        UNION ALL
        SELECT k.* FROM owned_keys k
         WHERE k.source_module = 'misc_income_entry'
           AND NOT EXISTS (SELECT 1 FROM misc_income_entries s WHERE s.id = k.reference_id)
        UNION ALL
        SELECT k.* FROM owned_keys k
         WHERE k.source_module = 'plot_payment'
           AND NOT EXISTS (SELECT 1 FROM plot_payments s WHERE s.id = k.reference_id)
        UNION ALL
        SELECT k.* FROM owned_keys k
         WHERE k.source_module = 'daybook'
           AND NOT EXISTS (SELECT 1 FROM day_book s WHERE s.id = k.reference_id)
      )
      SELECT reconcile_imprest_debit(
        source_module, reference_id, NULL, NULL, 0, FALSE, FALSE,
        'LEGACY SOURCE MISSING — IMPREST RESTORED', NULL
      )
        FROM missing_sources
    `);

    // The first local draft of this migration used an eight-argument helper
    // and was exercised before the reservation design was finalized. Remove
    // that unused overload after every trigger points at the nine-argument
    // implementation so a future manual call cannot bypass posting state.
    await client.query(`
      DROP FUNCTION IF EXISTS reconcile_imprest_debit(
        TEXT, INTEGER, INTEGER, INTEGER, NUMERIC, BOOLEAN, TEXT, TEXT
      )
    `);

    await client.query(`
      INSERT INTO public.app_schema_migrations (version)
      VALUES ('125_universal_imprest_enforcement')
      ON CONFLICT (version) DO NOTHING
    `);

    await client.query('COMMIT');
    console.log('Migration 125_universal_imprest_enforcement complete');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Migration 125_universal_imprest_enforcement failed:', error.message);
    throw error;
  } finally {
    client.release();
  }
};

migrate()
  .then(() => process.exit(0))
  .catch(() => process.exit(1));
