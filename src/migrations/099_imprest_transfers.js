import 'dotenv/config';
import pool from '../config/db.js';

/** Add atomic, auditable balance-to-balance transfers to Imprest Management. */
const migrate = async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('099_imprest_transfers'))`);

    await client.query(`
      ALTER TABLE imprest_ledger
        DROP CONSTRAINT IF EXISTS imprest_ledger_type_check
    `);
    await client.query(`
      ALTER TABLE imprest_ledger
        ADD CONSTRAINT imprest_ledger_type_check
        CHECK (type IN (
          'ALLOCATION', 'EXPENSE', 'ADJUSTMENT', 'REFUND',
          'TRANSFER_IN', 'TRANSFER_OUT', 'TRANSFER_REFUND'
        ))
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS imprest_transfers (
        id            SERIAL PRIMARY KEY,
        site_id       INTEGER NOT NULL REFERENCES sites(id) ON DELETE RESTRICT,
        from_user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        to_user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        amount        NUMERIC(15,2) NOT NULL CHECK (amount > 0),
        remark        TEXT,
        initiated_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT imprest_transfers_different_users CHECK (from_user_id <> to_user_id)
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_imprest_transfers_site_created ON imprest_transfers(site_id, created_at DESC, id DESC)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_imprest_transfers_from_user ON imprest_transfers(from_user_id, site_id, created_at DESC)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_imprest_transfers_to_user ON imprest_transfers(to_user_id, site_id, created_at DESC)`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS public.app_schema_migrations (
        version TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`
      INSERT INTO public.app_schema_migrations (version)
      VALUES ('099_imprest_transfers')
      ON CONFLICT (version) DO NOTHING
    `);

    await client.query('COMMIT');
    console.log('Migration 099_imprest_transfers complete');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Migration 099_imprest_transfers failed:', error.message);
    throw error;
  } finally {
    client.release();
  }
};

migrate().then(() => process.exit(0)).catch(() => process.exit(1));
