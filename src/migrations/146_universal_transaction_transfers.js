import pool from '../config/db.js';
import { MODULES } from '../controllers/transactionTransfer.controller.js';

// Additive schema change only; no accounting records are rewritten.
export async function up() {
  const db=await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query("SELECT pg_advisory_xact_lock(hashtext('146_universal_transaction_transfers'))");
    await db.query(`CREATE TABLE IF NOT EXISTS transaction_transfer_batches (
      request_id UUID PRIMARY KEY, request_hash TEXT NOT NULL,
      transferred_by INTEGER NOT NULL REFERENCES users(id), response JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    const types=Object.keys(MODULES).map(type=>`'${type}'`).join(',');
    for (const side of ['source','target']) {
      await db.query(`ALTER TABLE transaction_entry_transfers DROP CONSTRAINT IF EXISTS transaction_entry_transfers_${side}_type_check`);
      await db.query(`ALTER TABLE transaction_entry_transfers ADD CONSTRAINT transaction_entry_transfers_${side}_type_check CHECK (${side}_type IN (${types}))`);
    }
    await db.query('COMMIT');
    console.log('Universal transaction transfers schema ready');
  } catch(error) { await db.query('ROLLBACK'); throw error; }
  finally { db.release(); }
}
up().then(()=>pool.end()).catch(async error=>{console.error(error.message);await pool.end();process.exitCode=1;});
