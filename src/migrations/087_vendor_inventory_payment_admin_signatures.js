import pool from '../config/db.js';

/**
 * Migration: assigned_admin_id + signature columns on vendor_inventory_payments —
 * the one payment table migrations 020/067 missed, so it can be routed to an
 * approver and signed like every other payment table.
 */
const migrate = async () => {
  try {
    await pool.query(`
      ALTER TABLE vendor_inventory_payments
      ADD COLUMN IF NOT EXISTS assigned_admin_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS customer_signature_url TEXT,
      ADD COLUMN IF NOT EXISTS authority_signature_url TEXT
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_vendor_inventory_payments_assigned_admin_id
      ON vendor_inventory_payments(assigned_admin_id)
    `);
    console.log('✅ Migration 087 complete: assigned_admin_id + signature columns added to vendor_inventory_payments.');
  } catch (error) {
    console.error('❌ Migration 087 failed:', error.message);
    throw error;
  }
};

migrate()
  .then(() => process.exit(0))
  .catch(() => process.exit(1));
