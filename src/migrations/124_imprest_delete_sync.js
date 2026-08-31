import 'dotenv/config';
import pool from '../config/db.js';

// Approved sub-admin debits are mirrored into imprest_ledger. The source row
// remains the owner of that posting, so a hard delete must remove the mirror in
// the same transaction. Keeping this in PostgreSQL covers deletes from the
// source module, Day Book proxy routes, bulk actions, cascades, and future API
// paths without duplicating cleanup code in every controller.
const migrate = async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('124_imprest_delete_sync'))`);

    await client.query(`
      CREATE OR REPLACE FUNCTION delete_source_imprest_postings()
      RETURNS TRIGGER
      LANGUAGE plpgsql
      AS $$
      BEGIN
        DELETE FROM imprest_ledger
         WHERE source_module = TG_ARGV[0]
           AND reference_id = OLD.id
           AND type IN ('EXPENSE', 'ADJUSTMENT');
        RETURN OLD;
      END
      $$
    `);

    const sources = [
      ['expenses', 'expense'],
      ['farmer_payments', 'farmer_payment'],
      ['plot_commission_payments', 'plot_commission_payment'],
      ['vendor_payments', 'vendor_payment'],
      ['vendor_inventory_payments', 'vendor_inventory_payment'],
      ['day_book', 'daybook'],
    ];

    for (const [table, sourceModule] of sources) {
      const trigger = `trg_${table}_delete_imprest`;
      await client.query(`DROP TRIGGER IF EXISTS ${trigger} ON ${table}`);
      await client.query(`
        CREATE TRIGGER ${trigger}
        AFTER DELETE ON ${table}
        FOR EACH ROW
        EXECUTE FUNCTION delete_source_imprest_postings('${sourceModule}')
      `);
    }

    await client.query(`
      INSERT INTO public.app_schema_migrations (version)
      VALUES ('124_imprest_delete_sync')
      ON CONFLICT (version) DO NOTHING
    `);

    await client.query('COMMIT');
    console.log('Migration 124_imprest_delete_sync complete');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Migration 124_imprest_delete_sync failed:', error.message);
    throw error;
  } finally {
    client.release();
  }
};

migrate()
  .then(() => process.exit(0))
  .catch(() => process.exit(1));
