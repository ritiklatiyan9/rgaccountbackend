import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import pool from '../config/db.js';
import { up as refreshPairedTransferSchema } from './163_paired_transaction_transfers.js';

const SOURCE_TYPES = [
  'personal_ledger', 'expense', 'farmer_payment', 'plot_payment',
  'plot_commission', 'vendor_payment', 'vendor_inventory_payment',
  'misc_income', 'land_sale', 'daybook',
];
const TARGET_TYPES = [...SOURCE_TYPES, 'partner_profit'];
const quoted = (items) => items.map((item) => `'${item}'`).join(',');

// Migration 163 owns the transfer invariants. Re-running its idempotent schema
// refresh adds Partner Profit to the owner map, protected-leg triggers and pair
// validator. This migration then widens only the destination discriminator;
// Partner Profit payments remain destination-only because they cannot represent
// a credit leg in their positive debit-only table.
export async function up(database = pool) {
  await refreshPairedTransferSchema(database);
  const db = await database.connect();
  try {
    await db.query('BEGIN');
    await db.query("SELECT pg_advisory_xact_lock(hashtext('168_partner_profit_transfers'))");
    await db.query(`ALTER TABLE transaction_money_transfers
      DROP CONSTRAINT IF EXISTS transaction_money_transfers_source_type_check,
      DROP CONSTRAINT IF EXISTS transaction_money_transfers_target_type_check`);
    await db.query(`ALTER TABLE transaction_money_transfers
      ADD CONSTRAINT transaction_money_transfers_source_type_check
        CHECK (source_type IN (${quoted(SOURCE_TYPES)})),
      ADD CONSTRAINT transaction_money_transfers_target_type_check
        CHECK (target_type IN (${quoted(TARGET_TYPES)}))`);
    await db.query("INSERT INTO app_schema_migrations(version) VALUES ('168_partner_profit_transfers') ON CONFLICT DO NOTHING");
    await db.query('COMMIT');
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  } finally {
    db.release();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  up().then(() => console.log('Migration 168: Partner Profit transfer destination ready'))
    .catch((error) => { console.error(error.message); process.exitCode = 1; })
    .finally(() => pool.end());
}
