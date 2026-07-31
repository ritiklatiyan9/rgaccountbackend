import pool from '../config/db.js';

/**
 * Migration: signature columns on firm_transactions — the one payment table
 * migration 067 missed, so Quick Entry can sign every module it can write to.
 */
const migrate = async () => {
  try {
    await pool.query(`
      ALTER TABLE firm_transactions
      ADD COLUMN IF NOT EXISTS customer_signature_url TEXT,
      ADD COLUMN IF NOT EXISTS authority_signature_url TEXT
    `);
    console.log('✅ Migration 084 complete: signature columns added to firm_transactions.');
  } catch (error) {
    console.error('❌ Migration 084 failed:', error.message);
    throw error;
  }
};

migrate()
  .then(() => process.exit(0))
  .catch(() => process.exit(1));
