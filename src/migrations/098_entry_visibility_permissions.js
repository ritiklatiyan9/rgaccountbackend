import 'dotenv/config';
import pool from '../config/db.js';

/**
 * Adds an independent row-scope permission to every module permission.
 * Sub-admins default to their own records; admins and super-admins bypass it.
 */
const migrate = async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('098_entry_visibility_permissions'))`);
    await client.query(`
      ALTER TABLE user_permissions
      ADD COLUMN IF NOT EXISTS can_view_all BOOLEAN NOT NULL DEFAULT false
    `);

    // Creator-scoped list queries use these indexes on the busiest ledgers.
    await client.query(`CREATE INDEX IF NOT EXISTS idx_expenses_site_creator_date ON expenses(site_id, created_by, date DESC)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_day_book_site_creator_date ON day_book(site_id, created_by, date DESC)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_plot_payments_plot_creator_date ON plot_payments(plot_id, created_by, date DESC)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_plot_payments_site_creator_date ON plot_payments(site_id, created_by, date DESC)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_plot_installment_payments_creator_date ON plot_installment_payments(plot_id, created_by, payment_date DESC)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_farmer_payments_farmer_creator_date ON farmer_payments(farmer_id, created_by, date DESC)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_cash_flow_entries_site_creator_date ON cash_flow_entries(site_id, created_by, date DESC)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_firm_transactions_site_creator_date ON firm_transactions(site_id, created_by, date DESC)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_plot_commission_payments_creator_date ON plot_commission_payments(created_by, date DESC)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_plot_commission_payments_parent_creator_date ON plot_commission_payments(plot_commission_id, created_by, date DESC)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_vendor_payments_site_creator_date ON vendor_payments(site_id, created_by, payment_date DESC)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_vendor_inventory_payments_creator_date ON vendor_inventory_payments(created_by, payment_date DESC)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_vendor_inventory_payments_order_creator_date ON vendor_inventory_payments(order_id, created_by, payment_date DESC)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_plot_registry_payments_creator_date ON plot_registry_payments(created_by, payment_date DESC)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_plot_registry_payments_parent_creator_date ON plot_registry_payments(registry_id, created_by, payment_date DESC)`);

    await client.query('COMMIT');
    console.log('Migration 098_entry_visibility_permissions complete');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Migration 098_entry_visibility_permissions failed:', error.message);
    throw error;
  } finally {
    client.release();
  }
};

migrate().then(() => process.exit(0)).catch(() => process.exit(1));
