import pool from '../config/db.js';

// Lot expiry for the stock ledger: every stock-in movement (RECEIPT / RETURN /
// TRANSFER_IN / +ADJUSTMENT) is one lot and may carry an expiry_date. Stock-out
// rows never do. "Expiring" is derived by FIFO-depleting lots against the
// material's total stock-out (see Inventory.model.js LOT_BALANCE).
const migrate = async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`ALTER TABLE inventory_movements ADD COLUMN IF NOT EXISTS expiry_date DATE`);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_inv_mov_expiry
        ON inventory_movements(material_id, expiry_date) WHERE expiry_date IS NOT NULL
    `);
    await client.query('COMMIT');
    console.log('Migration 123_inventory_lot_expiry complete');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Migration 123_inventory_lot_expiry failed:', err.message);
    throw err;
  } finally {
    client.release();
  }
};

migrate()
  .then(() => process.exit(0))
  .catch(() => process.exit(1));
