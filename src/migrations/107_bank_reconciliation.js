import 'dotenv/config';
import pool from '../config/db.js';

export async function up() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('107_bank_reconciliation'))`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS bank_statement_uploads (
        id BIGSERIAL PRIMARY KEY,
        organization_id INTEGER NOT NULL,
        site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE RESTRICT,
        uploaded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        original_filename TEXT NOT NULL,
        content_type VARCHAR(160),
        file_size INTEGER NOT NULL CHECK (file_size > 0 AND file_size <= 10485760),
        file_hash CHAR(64) NOT NULL,
        parser_version VARCHAR(40) NOT NULL,
        statement_sheet TEXT,
        mapped_headers JSONB NOT NULL DEFAULT '{}'::jsonb,
        processing_state VARCHAR(24) NOT NULL DEFAULT 'PARSED'
          CHECK (processing_state IN ('PARSED', 'MATCHED', 'CONFIRMED', 'ERROR')),
        row_count INTEGER NOT NULL DEFAULT 0 CHECK (row_count >= 0),
        parse_error_count INTEGER NOT NULL DEFAULT 0 CHECK (parse_error_count >= 0),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (organization_id, site_id, file_hash)
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS bank_statement_transactions (
        id BIGSERIAL PRIMARY KEY,
        upload_id BIGINT NOT NULL REFERENCES bank_statement_uploads(id) ON DELETE CASCADE,
        organization_id INTEGER NOT NULL,
        site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE RESTRICT,
        row_number INTEGER NOT NULL CHECK (row_number > 0),
        transaction_date DATE,
        value_date DATE,
        transaction_reference TEXT,
        cheque_reference TEXT,
        narration TEXT,
        debit NUMERIC(18,2),
        credit NUMERIC(18,2),
        balance NUMERIC(18,2),
        account_suffix VARCHAR(32),
        branch TEXT,
        raw_row JSONB NOT NULL,
        normalized_row JSONB NOT NULL,
        row_fingerprint CHAR(64) NOT NULL,
        parse_errors JSONB NOT NULL DEFAULT '[]'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (upload_id, row_number)
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS bank_reconciliation_runs (
        id BIGSERIAL PRIMARY KEY,
        upload_id BIGINT NOT NULL REFERENCES bank_statement_uploads(id) ON DELETE CASCADE,
        organization_id INTEGER NOT NULL,
        site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE RESTRICT,
        mode VARCHAR(16) NOT NULL CHECK (mode IN ('MANUAL', 'AI')),
        status VARCHAR(20) NOT NULL DEFAULT 'RUNNING'
          CHECK (status IN ('RUNNING', 'COMPLETED', 'PARTIAL', 'FAILED', 'CONFIRMED')),
        resolver_version VARCHAR(40) NOT NULL,
        provider_request_id TEXT,
        provider_model TEXT,
        provider_latency_ms INTEGER,
        provider_usage JSONB,
        provider_error TEXT,
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        completed_at TIMESTAMPTZ
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS bank_reconciliation_suggestions (
        id BIGSERIAL PRIMARY KEY,
        run_id BIGINT NOT NULL REFERENCES bank_reconciliation_runs(id) ON DELETE CASCADE,
        bank_transaction_id BIGINT NOT NULL REFERENCES bank_statement_transactions(id) ON DELETE CASCADE,
        candidate_source VARCHAR(60),
        candidate_entry_id INTEGER,
        proposed_status VARCHAR(16)
          CHECK (proposed_status IS NULL OR proposed_status IN ('CLEARED', 'BOUNCED')),
        match_origin VARCHAR(24) NOT NULL
          CHECK (match_origin IN ('EXACT_RULE', 'AI_SUGGESTION', 'MANUAL_OVERRIDE', 'NONE')),
        confidence NUMERIC(5,4) NOT NULL DEFAULT 0 CHECK (confidence >= 0 AND confidence <= 1),
        review_state VARCHAR(24) NOT NULL DEFAULT 'REVIEW'
          CHECK (review_state IN ('MATCHED', 'REVIEW', 'BLOCKED', 'CONFIRMED')),
        matched_signals JSONB NOT NULL DEFAULT '[]'::jsonb,
        conflicting_signals JSONB NOT NULL DEFAULT '[]'::jsonb,
        warnings JSONB NOT NULL DEFAULT '[]'::jsonb,
        alternatives JSONB NOT NULL DEFAULT '[]'::jsonb,
        decision_reason TEXT,
        resolver_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        override_reason TEXT,
        overridden_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        overridden_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (run_id, bank_transaction_id)
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS bank_reconciliation_links (
        id BIGSERIAL PRIMARY KEY,
        organization_id INTEGER NOT NULL,
        site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE RESTRICT,
        upload_id BIGINT NOT NULL REFERENCES bank_statement_uploads(id) ON DELETE RESTRICT,
        run_id BIGINT NOT NULL REFERENCES bank_reconciliation_runs(id) ON DELETE RESTRICT,
        suggestion_id BIGINT NOT NULL REFERENCES bank_reconciliation_suggestions(id) ON DELETE RESTRICT,
        bank_transaction_id BIGINT NOT NULL REFERENCES bank_statement_transactions(id) ON DELETE RESTRICT,
        candidate_source VARCHAR(60) NOT NULL,
        candidate_entry_id INTEGER NOT NULL,
        resulting_status VARCHAR(16) NOT NULL CHECK (resulting_status IN ('CLEARED', 'BOUNCED')),
        bank_value_date DATE,
        bank_reference TEXT,
        row_fingerprint CHAR(64) NOT NULL,
        confirmed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        confirmed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (bank_transaction_id),
        UNIQUE (organization_id, site_id, candidate_source, candidate_entry_id),
        UNIQUE (organization_id, site_id, row_fingerprint)
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS bank_reconciliation_aliases (
        id BIGSERIAL PRIMARY KEY,
        organization_id INTEGER NOT NULL,
        site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
        entity_source VARCHAR(60) NOT NULL,
        entity_entry_id INTEGER NOT NULL,
        alias_value TEXT NOT NULL,
        normalized_alias TEXT NOT NULL,
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (organization_id, site_id, entity_source, entity_entry_id, normalized_alias)
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS bank_reconciliation_candidate_metadata (
        id BIGSERIAL PRIMARY KEY,
        organization_id INTEGER NOT NULL,
        site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
        entity_source VARCHAR(60) NOT NULL,
        entity_entry_id INTEGER NOT NULL,
        payer_names JSONB NOT NULL DEFAULT '[]'::jsonb,
        booking_reference TEXT,
        plot_reference TEXT,
        account_suffix VARCHAR(32),
        bank_name TEXT,
        seed_key TEXT,
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (organization_id, site_id, entity_source, entity_entry_id),
        UNIQUE (organization_id, site_id, seed_key)
      )
    `);

    await client.query(`CREATE INDEX IF NOT EXISTS idx_bank_uploads_site_created ON bank_statement_uploads (organization_id, site_id, created_at DESC)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_bank_transactions_upload ON bank_statement_transactions (upload_id, row_number)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_bank_transactions_fingerprint ON bank_statement_transactions (organization_id, site_id, row_fingerprint)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_bank_runs_upload ON bank_reconciliation_runs (upload_id, created_at DESC)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_bank_suggestions_run_state ON bank_reconciliation_suggestions (run_id, review_state)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_bank_alias_lookup ON bank_reconciliation_aliases (organization_id, site_id, normalized_alias)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_bank_candidate_metadata_lookup ON bank_reconciliation_candidate_metadata (organization_id, site_id, entity_source, entity_entry_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_pending_cheques_cfe ON cash_flow_entries (site_id, cheque_no, bank_account_id) WHERE UPPER(COALESCE(cheque_status, '')) = 'PENDING'`);

    await client.query('COMMIT');
    console.log('Migration 107: bank statement cheque reconciliation is ready');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

up()
  .catch((error) => {
    console.error('Migration 107 failed:', error.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
