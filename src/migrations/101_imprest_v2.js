import 'dotenv/config';
import pool from '../config/db.js';

/**
 * Imprest v2 — consolidates imprest schema that previously lived only in ad-hoc
 * root scripts (migrate_imprest_returns.js, fix_imprest_request_type.mjs,
 * migrate_imprest_site_id.mjs) so a DB provisioned from the dumps works, and
 * adds optional camera-proof columns (proof_key) for imprest movements.
 * Pure DDL, idempotent, safe to re-run. No data backfills here — the historical
 * site_id backfill stays in migrate_imprest_site_id.mjs (run manually, once).
 */
const migrate = async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('101_imprest_v2'))`);

    // 1. site_id columns (previously only in migrate_imprest_site_id.mjs)
    await client.query(`ALTER TABLE imprest_allocations ADD COLUMN IF NOT EXISTS site_id INTEGER REFERENCES sites(id)`);
    await client.query(`ALTER TABLE imprest_ledger ADD COLUMN IF NOT EXISTS site_id INTEGER REFERENCES sites(id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_il_site_user ON imprest_ledger(site_id, user_id, created_at DESC)`);

    // 2. imprest_returns table (previously only in migrate_imprest_returns.js)
    await client.query(`
      CREATE TABLE IF NOT EXISTS imprest_returns (
        id                SERIAL PRIMARY KEY,
        sub_admin_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        amount            NUMERIC(15,2) NOT NULL,
        reason            TEXT,
        payment_mode      VARCHAR(30) DEFAULT 'CASH',
        status            VARCHAR(30) NOT NULL DEFAULT 'PENDING'
                            CHECK (status IN ('PENDING', 'ACCEPTED', 'REJECTED')),
        reviewed_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
        reviewed_at       TIMESTAMPTZ,
        review_remark     TEXT,
        site_id           INTEGER REFERENCES sites(id) ON DELETE SET NULL,
        assigned_admin_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at        TIMESTAMPTZ DEFAULT NOW(),
        updated_at        TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_ir_sub_admin ON imprest_returns(sub_admin_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_ir_status ON imprest_returns(status)`);
    await client.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_imprest_returns_updated_at') THEN
          CREATE TRIGGER trg_imprest_returns_updated_at
            BEFORE UPDATE ON imprest_returns
            FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
        END IF;
      END $$
    `);

    // 3. request_type (previously only in fix_imprest_request_type.mjs)
    await client.query(`
      ALTER TABLE imprest_expense_requests
        ADD COLUMN IF NOT EXISTS request_type VARCHAR(20) NOT NULL DEFAULT 'EXPENSE'
          CHECK (request_type IN ('IMPREST', 'EXPENSE'))
    `);

    // 4. Optional camera-proof storage keys (S3 key or local:: fallback)
    await client.query(`ALTER TABLE imprest_allocations ADD COLUMN IF NOT EXISTS proof_key TEXT`);
    await client.query(`ALTER TABLE imprest_ledger ADD COLUMN IF NOT EXISTS proof_key TEXT`);
    await client.query(`ALTER TABLE imprest_returns ADD COLUMN IF NOT EXISTS proof_key TEXT`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS public.app_schema_migrations (
        version TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`
      INSERT INTO public.app_schema_migrations (version)
      VALUES ('101_imprest_v2')
      ON CONFLICT (version) DO NOTHING
    `);

    await client.query('COMMIT');
    console.log('Migration 101_imprest_v2 complete');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Migration 101_imprest_v2 failed:', error.message);
    throw error;
  } finally {
    client.release();
  }
};

migrate().then(() => process.exit(0)).catch(() => process.exit(1));
