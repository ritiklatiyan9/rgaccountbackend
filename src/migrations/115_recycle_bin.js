import 'dotenv/config';
import pool from '../config/db.js';

// Tables that are operational history, authentication state, delivery queues,
// or caches are deliberately excluded. They are not user-owned module records
// and replaying them would either recreate sessions/notifications or corrupt an
// append-only audit trail.
const EXCLUDED_TABLES = [
  'agent_activity_log',
  'app_schema_migrations',
  'audit_logs',
  'compliance_audit_log',
  'compliance_notification_log',
  'draw_events',
  'event_reminders',
  'geocode_cache',
  // Source-qualified imprest rows are generated accounting state. Restoring
  // the canonical debit recreates them under the sufficient-balance guard.
  'imprest_ledger',
  'imprest_debit_reservations',
  'login_otps',
  'recycle_bin_entries',
  'reminder_scheduler_health',
  'sms_reminder_log',
  'transaction_receipt_prints',
  'user_push_tokens',
  'user_sessions',
];

export async function up() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('115_recycle_bin'))`);

    await client.query(`
      ALTER TABLE user_permissions
        ADD COLUMN IF NOT EXISTS can_restore BOOLEAN NOT NULL DEFAULT FALSE
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS recycle_bin_entries (
        id BIGSERIAL PRIMARY KEY,
        organization_id INTEGER NOT NULL DEFAULT 1,
        site_id INTEGER,
        deletion_batch BIGINT NOT NULL,
        source_schema TEXT NOT NULL DEFAULT 'public',
        source_table TEXT NOT NULL,
        source_module TEXT NOT NULL,
        source_primary_key JSONB NOT NULL DEFAULT '{}'::jsonb,
        record_id TEXT,
        display_name TEXT NOT NULL,
        delete_kind VARCHAR(8) NOT NULL DEFAULT 'HARD'
          CHECK (delete_kind IN ('HARD', 'SOFT')),
        row_data JSONB NOT NULL,
        deleted_by INTEGER,
        deleted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        restored_by INTEGER,
        restored_at TIMESTAMPTZ
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_recycle_bin_active ON recycle_bin_entries (organization_id, deleted_at DESC) WHERE restored_at IS NULL`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_recycle_bin_restored ON recycle_bin_entries (organization_id, restored_at DESC) WHERE restored_at IS NOT NULL`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_recycle_bin_batch ON recycle_bin_entries (deletion_batch, id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_recycle_bin_site ON recycle_bin_entries (site_id, deleted_at DESC)`);

    await client.query(`
      CREATE OR REPLACE FUNCTION recycle_bin_module_for_table(p_table TEXT)
      RETURNS TEXT
      LANGUAGE SQL
      IMMUTABLE
      AS $$
        SELECT CASE
          WHEN p_table IN ('members','member_categories','bookings','kyc_cases') THEN 'clients'
          WHEN p_table IN ('farmers','farmer_payments','land_deals','land_deal_payments') THEN 'farmers'
          WHEN p_table LIKE 'plot_commission%' THEN 'commissions'
          WHEN p_table IN ('day_book','day_book_daily_balance','daybook_entry_order','daybook_global_order','daybook_order_state','daybook_global_order_state') THEN 'daybook'
          WHEN p_table LIKE 'cash_flow_%' THEN 'cashflow'
          WHEN p_table = 'bank_accounts' THEN 'daybook'
          WHEN p_table IN ('firms','firm_transactions','transaction_entry_transfers') THEN 'firm_transactions'
          WHEN p_table IN ('plots','plot_payments','plot_installments','plot_installment_payments','transaction_receipts') THEN 'plot_payments'
          WHEN p_table LIKE 'plot_registr%' OR p_table = 'registry_document_handovers' THEN 'plot_registry'
          WHEN p_table IN ('documents','ocr_results') THEN 'document_search'
          WHEN p_table IN ('expenses','expense_categories') THEN 'expenses'
          WHEN p_table LIKE 'misc_income_%' THEN 'misc_income'
          WHEN p_table LIKE 'imprest_%' THEN 'imprest'
          WHEN p_table = 'document_imprest' THEN 'document_imprest'
          WHEN p_table LIKE 'vendor_%' THEN 'vendors'
          WHEN p_table LIKE 'construction_%' THEN 'construction'
          WHEN p_table LIKE 'inventory_%' THEN 'inventory'
          WHEN p_table IN ('excel_files','file_folders') THEN 'excel'
          WHEN p_table IN ('conversations','messages') THEN 'chat'
          WHEN p_table LIKE 'compliance_%' THEN 'compliance'
          WHEN p_table LIKE 'legal_%' THEN 'legal'
          WHEN p_table IN ('upi_accounts','payment_qrs') THEN 'upi_collect'
          WHEN p_table LIKE 'bank_reconciliation_%' OR p_table LIKE 'bank_statement_%' THEN 'bank_reconciliation'
          WHEN p_table IN ('users','user_sites','user_permissions','user_approval_modules','user_home_layouts','dashboard_component_permissions') THEN 'administration'
          WHEN p_table IN ('sites','project_settings','application_settings','teams','team_members') THEN 'settings'
          ELSE regexp_replace(p_table, '_+', '_', 'g')
        END
      $$
    `);

    await client.query(`
      CREATE OR REPLACE FUNCTION archive_record_in_recycle_bin()
      RETURNS TRIGGER
      LANGUAGE plpgsql
      AS $$
      DECLARE
        v_row JSONB := to_jsonb(OLD);
        v_primary_key JSONB;
        v_site_id INTEGER;
        v_organization_id INTEGER;
        v_deleted_by INTEGER;
        v_record_id TEXT;
        v_display_name TEXT;
        v_source_module TEXT;
        v_delete_kind TEXT := 'HARD';
      BEGIN
        IF current_setting('app.recycle_bin_skip', TRUE) = 'on' THEN
          IF TG_OP = 'UPDATE' THEN RETURN NEW; END IF;
          RETURN OLD;
        END IF;
        IF TG_OP = 'UPDATE' THEN
          IF OLD.deleted_at IS NOT NULL OR NEW.deleted_at IS NULL THEN
            RETURN NEW;
          END IF;
          v_delete_kind := 'SOFT';
        END IF;

        SELECT COALESCE(jsonb_object_agg(attribute_name, v_row -> attribute_name), '{}'::jsonb)
          INTO v_primary_key
          FROM (
            SELECT a.attname AS attribute_name
              FROM pg_index i
              JOIN pg_attribute a
                ON a.attrelid = i.indrelid
               AND a.attnum = ANY(i.indkey)
             WHERE i.indrelid = TG_RELID
               AND i.indisprimary
          ) primary_columns;

        v_record_id := COALESCE(
          NULLIF(v_row ->> 'id', ''), NULLIF(v_row ->> 'code', ''),
          NULLIF(v_row ->> 'version', ''), NULLIF(v_row ->> 'setting_key', '')
        );
        v_display_name := COALESCE(
          NULLIF(v_row ->> 'full_name', ''), NULLIF(v_row ->> 'name', ''),
          NULLIF(v_row ->> 'title', ''), NULLIF(v_row ->> 'plot_no', ''),
          NULLIF(v_row ->> 'booking_no', ''), NULLIF(v_row ->> 'deal_no', ''),
          NULLIF(v_row ->> 'vendor_name', ''), NULLIF(v_row ->> 'customer_name', ''),
          NULLIF(v_row ->> 'buyer_name', ''), NULLIF(v_row ->> 'document_name', ''),
          NULLIF(v_row ->> 'original_name', ''), NULLIF(v_row ->> 'work_title', ''),
          NULLIF(v_row ->> 'particular', ''), NULLIF(v_row ->> 'description', ''),
          NULLIF(v_row ->> 'remark', ''), NULLIF(v_row ->> 'notes', ''),
          initcap(replace(TG_TABLE_NAME, '_', ' ')) || COALESCE(' #' || v_record_id, '')
        );
        v_source_module := recycle_bin_module_for_table(TG_TABLE_NAME);
        IF TG_TABLE_NAME = 'documents' THEN
          v_source_module := CASE UPPER(COALESCE(v_row ->> 'uploaded_source', ''))
            WHEN 'PLOT_REGISTRY' THEN 'plot_registry'
            WHEN 'FARMER' THEN 'farmers'
            WHEN 'DMS' THEN 'document_search'
            WHEN 'ACCOUNT_RECORD' THEN CASE
              WHEN UPPER(COALESCE(v_row ->> 'entity_type', '')) IN ('FARMER', 'LAND_DEAL') THEN 'farmers'
              WHEN UPPER(COALESCE(v_row ->> 'entity_type', '')) IN ('VENDOR', 'VENDOR_COMMITMENT') THEN 'vendors'
              WHEN UPPER(COALESCE(v_row ->> 'entity_type', '')) IN ('PLOT', 'PLOT_PAYMENT') THEN 'plot_payments'
              WHEN UPPER(COALESCE(v_row ->> 'entity_type', '')) IN ('REGISTRY', 'PLOT_REGISTRY') THEN 'plot_registry'
              ELSE 'document_search'
            END
            ELSE CASE WHEN v_row ->> 'plot_id' IS NOT NULL THEN 'plot_payments' ELSE 'clients' END
          END;
        ELSIF TG_TABLE_NAME = 'transaction_receipts' THEN
          v_source_module := COALESCE(NULLIF(v_row ->> 'module', ''), 'plot_payments');
        END IF;

        BEGIN
          v_site_id := NULLIF(v_row ->> 'site_id', '')::INTEGER;
        EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
          v_site_id := NULL;
        END;
        IF TG_TABLE_NAME = 'sites' THEN
          BEGIN v_site_id := NULLIF(v_row ->> 'id', '')::INTEGER;
          EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN v_site_id := NULL;
          END;
        END IF;
        IF v_site_id IS NULL THEN
          CASE TG_TABLE_NAME
            WHEN 'farmer_payments' THEN
              SELECT site_id INTO v_site_id FROM farmers WHERE id = NULLIF(v_row ->> 'farmer_id', '')::INTEGER;
            WHEN 'construction_tasks' THEN
              SELECT site_id INTO v_site_id FROM construction_projects WHERE id = NULLIF(v_row ->> 'project_id', '')::INTEGER;
            WHEN 'construction_material_request_items' THEN
              SELECT r.site_id INTO v_site_id FROM construction_material_requests r WHERE r.id = NULLIF(v_row ->> 'request_id', '')::INTEGER;
            WHEN 'plot_installments' THEN
              SELECT site_id INTO v_site_id FROM plots WHERE id = NULLIF(v_row ->> 'plot_id', '')::INTEGER;
            WHEN 'plot_installment_payments' THEN
              SELECT site_id INTO v_site_id FROM plots WHERE id = NULLIF(v_row ->> 'plot_id', '')::INTEGER;
            WHEN 'ocr_results' THEN
              SELECT site_id INTO v_site_id FROM documents WHERE id = NULLIF(v_row ->> 'document_id', '')::INTEGER;
            WHEN 'compliance_checklist_items' THEN
              SELECT site_id INTO v_site_id FROM compliance_items WHERE id = NULLIF(v_row ->> 'compliance_item_id', '')::INTEGER;
            WHEN 'compliance_approvals' THEN
              SELECT site_id INTO v_site_id FROM compliance_items WHERE id = NULLIF(v_row ->> 'compliance_item_id', '')::INTEGER;
            WHEN 'compliance_due_date_changes' THEN
              SELECT site_id INTO v_site_id FROM compliance_items WHERE id = NULLIF(v_row ->> 'compliance_item_id', '')::INTEGER;
            WHEN 'compliance_status_history' THEN
              SELECT site_id INTO v_site_id FROM compliance_items WHERE id = NULLIF(v_row ->> 'compliance_item_id', '')::INTEGER;
            WHEN 'legal_case_timeline' THEN
              SELECT site_id INTO v_site_id FROM legal_cases WHERE id = NULLIF(v_row ->> 'legal_case_id', '')::INTEGER;
            WHEN 'draw_payments' THEN
              SELECT site_id INTO v_site_id FROM draw_registrations WHERE id = NULLIF(v_row ->> 'draw_registration_id', '')::INTEGER;
            WHEN 'team_members' THEN
              SELECT site_id INTO v_site_id FROM teams WHERE id = NULLIF(v_row ->> 'team_id', '')::INTEGER;
            ELSE NULL;
          END CASE;
        END IF;
        IF v_site_id IS NULL THEN
          SELECT site_id INTO v_site_id
            FROM recycle_bin_entries
           WHERE deletion_batch = txid_current() AND site_id IS NOT NULL
           ORDER BY id
           LIMIT 1;
        END IF;

        BEGIN
          v_organization_id := NULLIF(v_row ->> 'organization_id', '')::INTEGER;
        EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
          v_organization_id := NULL;
        END;
        IF TG_TABLE_NAME = 'organizations' THEN
          BEGIN v_organization_id := NULLIF(v_row ->> 'id', '')::INTEGER;
          EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN v_organization_id := NULL;
          END;
        END IF;
        IF v_organization_id IS NULL AND v_site_id IS NOT NULL THEN
          SELECT organization_id INTO v_organization_id FROM sites WHERE id = v_site_id;
        END IF;
        IF v_organization_id IS NULL THEN
          SELECT organization_id INTO v_organization_id
            FROM recycle_bin_entries
           WHERE deletion_batch = txid_current()
           ORDER BY id
           LIMIT 1;
        END IF;
        v_organization_id := COALESCE(v_organization_id, 1);

        BEGIN
          v_deleted_by := NULLIF(current_setting('app.current_user_id', TRUE), '')::INTEGER;
        EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
          v_deleted_by := NULL;
        END;

        INSERT INTO recycle_bin_entries (
          organization_id, site_id, deletion_batch, source_schema, source_table,
          source_module, source_primary_key, record_id, display_name, delete_kind,
          row_data, deleted_by
        ) VALUES (
          v_organization_id, v_site_id, txid_current(), TG_TABLE_SCHEMA, TG_TABLE_NAME,
          v_source_module, v_primary_key, v_record_id,
          left(v_display_name, 500), v_delete_kind, v_row, v_deleted_by
        );

        IF TG_OP = 'UPDATE' THEN RETURN NEW; END IF;
        RETURN OLD;
      END
      $$
    `);

    await client.query(`
      CREATE OR REPLACE FUNCTION restore_recycle_bin_batch(p_batch BIGINT, p_user_id INTEGER)
      RETURNS INTEGER
      LANGUAGE plpgsql
      AS $$
      DECLARE
        v_entry RECORD;
        v_columns TEXT;
        v_progress INTEGER;
        v_remaining INTEGER;
        v_restored INTEGER := 0;
        v_updated INTEGER;
        v_pass INTEGER;
        v_max_passes INTEGER;
      BEGIN
        SELECT COUNT(*)::INTEGER + 1 INTO v_max_passes
          FROM recycle_bin_entries
         WHERE deletion_batch = p_batch AND restored_at IS NULL;
        IF v_max_passes <= 1 THEN
          RAISE EXCEPTION 'Recycle-bin transaction % is empty or already restored', p_batch
            USING ERRCODE = 'P0002';
        END IF;

        FOR v_pass IN 1..v_max_passes LOOP
          v_progress := 0;
          FOR v_entry IN
            SELECT * FROM recycle_bin_entries
             WHERE deletion_batch = p_batch AND restored_at IS NULL
             -- Derived ledger rows are deleted by AFTER DELETE triggers, so
             -- they are archived after their source. Replaying newest-first
             -- restores those mirrors before source INSERT triggers upsert
             -- them, avoiding duplicate source_module/source_id conflicts.
             ORDER BY id DESC
          LOOP
            BEGIN
              -- Older deletion batches may contain generated imprest rows from
              -- before migration 125. Never replay those negative mirrors
              -- directly; restoring their canonical source reconciles them.
              IF v_entry.source_table = 'imprest_ledger'
                 AND COALESCE(v_entry.row_data ->> 'source_module', '') <> '' THEN
                UPDATE recycle_bin_entries
                   SET restored_at = NOW(), restored_by = p_user_id
                 WHERE id = v_entry.id;
                v_progress := v_progress + 1;
                v_restored := v_restored + 1;
                CONTINUE;
              END IF;

              IF to_regclass(format('%I.%I', v_entry.source_schema, v_entry.source_table)) IS NULL THEN
                RAISE EXCEPTION 'Source table %.% no longer exists', v_entry.source_schema, v_entry.source_table;
              END IF;

              IF v_entry.delete_kind = 'SOFT' THEN
                IF v_entry.source_primary_key = '{}'::jsonb THEN
                  RAISE EXCEPTION 'Cannot safely restore %.% without a primary key', v_entry.source_schema, v_entry.source_table;
                END IF;
                EXECUTE format(
                  'UPDATE %I.%I AS target SET deleted_at = NULL WHERE to_jsonb(target) @> $1',
                  v_entry.source_schema, v_entry.source_table
                ) USING v_entry.source_primary_key;
                GET DIAGNOSTICS v_updated = ROW_COUNT;
                IF v_updated <> 1 THEN
                  RAISE EXCEPTION 'Expected one soft-deleted %.% record, found %', v_entry.source_schema, v_entry.source_table, v_updated;
                END IF;
              ELSE
                SELECT string_agg(format('%I', a.attname), ', ' ORDER BY a.attnum)
                  INTO v_columns
                  FROM pg_attribute a
                 WHERE a.attrelid = to_regclass(format('%I.%I', v_entry.source_schema, v_entry.source_table))
                   AND a.attnum > 0
                   AND NOT a.attisdropped
                   AND a.attgenerated = ''
                   AND v_entry.row_data ? a.attname;
                IF v_columns IS NULL THEN
                  RAISE EXCEPTION 'No restorable columns remain on %.%', v_entry.source_schema, v_entry.source_table;
                END IF;
                EXECUTE format(
                  'INSERT INTO %I.%I (%s) OVERRIDING SYSTEM VALUE SELECT %s FROM jsonb_populate_record(NULL::%I.%I, $1)',
                  v_entry.source_schema, v_entry.source_table, v_columns, v_columns,
                  v_entry.source_schema, v_entry.source_table
                ) USING v_entry.row_data;
              END IF;

              UPDATE recycle_bin_entries
                 SET restored_at = NOW(), restored_by = p_user_id
               WHERE id = v_entry.id;
              v_progress := v_progress + 1;
              v_restored := v_restored + 1;
            EXCEPTION
              WHEN foreign_key_violation THEN
                -- A parent from the same deletion transaction has not been
                -- replayed yet. The next pass retries this row.
                NULL;
              WHEN unique_violation THEN
                RAISE EXCEPTION 'Cannot restore %.%: an active record already uses the same unique value', v_entry.source_schema, v_entry.source_table
                  USING ERRCODE = '23505';
            END;
          END LOOP;

          SELECT COUNT(*)::INTEGER INTO v_remaining
            FROM recycle_bin_entries
           WHERE deletion_batch = p_batch AND restored_at IS NULL;
          IF v_remaining = 0 THEN RETURN v_restored; END IF;
          IF v_progress = 0 THEN
            RAISE EXCEPTION 'Could not restore transaction % because % dependent record(s) are still blocked', p_batch, v_remaining
              USING ERRCODE = '23503';
          END IF;
        END LOOP;

        RAISE EXCEPTION 'Could not fully restore recycle-bin transaction %', p_batch;
      END
      $$
    `);

    await client.query(`
      CREATE OR REPLACE FUNCTION purge_recycle_bin_batch(p_batch BIGINT)
      RETURNS INTEGER
      LANGUAGE plpgsql
      AS $$
      DECLARE
        v_entry RECORD;
        v_purged INTEGER;
      BEGIN
        PERFORM set_config('app.recycle_bin_skip', 'on', TRUE);
        FOR v_entry IN
          SELECT * FROM recycle_bin_entries
           WHERE deletion_batch = p_batch AND restored_at IS NULL AND delete_kind = 'SOFT'
           ORDER BY id DESC
        LOOP
          IF v_entry.source_primary_key <> '{}'::jsonb
             AND to_regclass(format('%I.%I', v_entry.source_schema, v_entry.source_table)) IS NOT NULL THEN
            EXECUTE format(
              'DELETE FROM %I.%I AS target WHERE to_jsonb(target) @> $1',
              v_entry.source_schema, v_entry.source_table
            ) USING v_entry.source_primary_key;
          END IF;
        END LOOP;

        DELETE FROM recycle_bin_entries
         WHERE deletion_batch = p_batch AND restored_at IS NULL;
        GET DIAGNOSTICS v_purged = ROW_COUNT;
        RETURN v_purged;
      END
      $$
    `);

    // Re-running this migration on each backend start also attaches protection
    // to tables introduced by later module migrations.
    const { rows: tables } = await client.query(
      `SELECT c.relname AS table_name,
              EXISTS (
                SELECT 1 FROM pg_attribute a
                 WHERE a.attrelid = c.oid AND a.attname = 'deleted_at'
                   AND a.attnum > 0 AND NOT a.attisdropped
              ) AS supports_soft_delete,
              EXISTS (
                SELECT 1 FROM pg_trigger t
                 WHERE t.tgrelid = c.oid AND t.tgname = 'trg_recycle_bin_delete'
                   AND NOT t.tgisinternal
              ) AS has_delete_trigger,
              EXISTS (
                SELECT 1 FROM pg_trigger t
                 WHERE t.tgrelid = c.oid AND t.tgname = 'trg_recycle_bin_soft_delete'
                   AND NOT t.tgisinternal
              ) AS has_soft_delete_trigger
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relkind IN ('r', 'p')
          AND c.relname <> ALL($1::text[])
        ORDER BY c.relname`,
      [EXCLUDED_TABLES]
    );
    for (const table of tables) {
      const safeTable = `"${table.table_name.replaceAll('"', '""')}"`;
      if (!table.has_delete_trigger) {
        await client.query(`CREATE TRIGGER trg_recycle_bin_delete BEFORE DELETE ON public.${safeTable} FOR EACH ROW EXECUTE FUNCTION archive_record_in_recycle_bin()`);
      }
      if (table.supports_soft_delete && !table.has_soft_delete_trigger) {
        await client.query(`CREATE TRIGGER trg_recycle_bin_soft_delete BEFORE UPDATE OF deleted_at ON public.${safeTable} FOR EACH ROW EXECUTE FUNCTION archive_record_in_recycle_bin()`);
      }
    }

    await client.query('COMMIT');
    console.log(`Migration 115: recycle bin ready across ${tables.length} data tables`);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

up()
  .catch((error) => {
    console.error('Migration 115 failed:', error.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
