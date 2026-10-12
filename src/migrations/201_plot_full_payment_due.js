import pool from '../config/db.js';

export async function up(database = pool) {
  await database.query(`ALTER TABLE plots
    ADD COLUMN IF NOT EXISTS full_payment_due BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS full_payment_due_date DATE`);
}
