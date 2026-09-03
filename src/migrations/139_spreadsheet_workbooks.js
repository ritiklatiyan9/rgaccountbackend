import 'dotenv/config';
import pool from '../config/db.js';

/**
 * Native spreadsheet workbooks.
 *
 * Storage decision (hybrid):
 *  - spreadsheet_workbooks  : tenant-scoped metadata + optimistic-lock version.
 *  - spreadsheet_sheets     : ONE JSONB document per sheet (sparse `celldata`
 *                             plus config/merges/widths/filters/validation/
 *                             conditional formats/frozen panes/hyperlinks).
 *                             Cell-level ops from the client are applied to the
 *                             document server-side, so a keystroke ships a few
 *                             bytes, not the workbook.
 *  - spreadsheet_versions   : bounded snapshots (import/restore/manual + one
 *                             automatic checkpoint per 30 min of edits).
 *  - spreadsheet_shares     : per-user access levels (owner/editor/commenter/viewer).
 *
 * Normalised per-cell rows were rejected: a 50k-row sheet would be 500k rows
 * that every open has to re-assemble, and nothing queries individual cells.
 * ponytail: one JSONB doc per sheet; split into a cells table if sheets
 * routinely exceed ~250k cells.
 */
export async function up() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('139_spreadsheet_workbooks'))`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS spreadsheet_workbooks (
        id BIGSERIAL PRIMARY KEY,
        organization_id INTEGER NOT NULL DEFAULT 1 REFERENCES organizations(id),
        site_id INTEGER REFERENCES sites(id) ON DELETE CASCADE,
        name VARCHAR(255) NOT NULL,
        description TEXT,
        status VARCHAR(20) NOT NULL DEFAULT 'active'
          CHECK (status IN ('active', 'archived')),
        owner_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        version INTEGER NOT NULL DEFAULT 1,
        settings JSONB NOT NULL DEFAULT '{}'::jsonb,
        legacy_file_id INTEGER UNIQUE REFERENCES excel_files(id) ON DELETE SET NULL,
        last_checkpoint_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        deleted_at TIMESTAMPTZ
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_ss_workbooks_org_site ON spreadsheet_workbooks (organization_id, site_id, updated_at DESC)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_ss_workbooks_org_id ON spreadsheet_workbooks (organization_id, id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_ss_workbooks_owner ON spreadsheet_workbooks (owner_user_id)`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS spreadsheet_sheets (
        id BIGSERIAL PRIMARY KEY,
        workbook_id BIGINT NOT NULL REFERENCES spreadsheet_workbooks(id) ON DELETE CASCADE,
        sheet_key VARCHAR(64) NOT NULL,
        name VARCHAR(255) NOT NULL,
        sort_order INTEGER NOT NULL DEFAULT 0,
        hidden BOOLEAN NOT NULL DEFAULT FALSE,
        data JSONB NOT NULL DEFAULT '{}'::jsonb,
        cell_count INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (workbook_id, sheet_key)
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_ss_sheets_workbook_order ON spreadsheet_sheets (workbook_id, sort_order)`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS spreadsheet_versions (
        id BIGSERIAL PRIMARY KEY,
        workbook_id BIGINT NOT NULL REFERENCES spreadsheet_workbooks(id) ON DELETE CASCADE,
        version INTEGER NOT NULL,
        action VARCHAR(40) NOT NULL,
        label VARCHAR(255),
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        snapshot JSONB NOT NULL,
        size_bytes INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_ss_versions_workbook ON spreadsheet_versions (workbook_id, created_at DESC)`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS spreadsheet_shares (
        id BIGSERIAL PRIMARY KEY,
        workbook_id BIGINT NOT NULL REFERENCES spreadsheet_workbooks(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        access_level VARCHAR(20) NOT NULL
          CHECK (access_level IN ('editor', 'commenter', 'viewer')),
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (workbook_id, user_id)
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_ss_shares_user ON spreadsheet_shares (user_id)`);

    await client.query('COMMIT');
    console.log('Migration 139: spreadsheet workbook tables are ready');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

up()
  .catch((error) => {
    console.error('Migration 139 failed:', error.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
