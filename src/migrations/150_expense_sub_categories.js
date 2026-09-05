import 'dotenv/config';
import pool from '../config/db.js';

/**
 * Expense sub-categories — a finer split under a category (KITCHEN › CYLINDER).
 *
 * Expenses store their category as plain uppercase text and the predefined
 * categories exist only in the frontend list, so the sub-category list is
 * keyed by the category NAME rather than a foreign key, and the expense row
 * carries its chosen sub-category as text — exactly how `category` works.
 */
export async function up() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('150_expense_sub_categories'))`);
    await client.query(`
      CREATE TABLE IF NOT EXISTS expense_sub_categories (
        id         SERIAL PRIMARY KEY,
        category   VARCHAR(100) NOT NULL,
        name       VARCHAR(100) NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_expense_sub_categories_category_name
        ON expense_sub_categories (category, name)
    `);
    await client.query(`ALTER TABLE expenses ADD COLUMN IF NOT EXISTS sub_category VARCHAR(100)`);
    await client.query('COMMIT');
    console.log('Migration 150: expense sub-categories ready');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

up()
  .catch((error) => {
    console.error('Migration 150 failed:', error.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
