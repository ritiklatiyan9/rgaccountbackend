import { pathToFileURL } from 'node:url';
import pool from '../config/db.js';

export async function up(database = pool) {
  // Record-only register: nothing here posts to the ledger. The challan deposit
  // itself is booked as an expense, so no balance changes.
  await database.query(`CREATE TABLE IF NOT EXISTS tds_deductions (
    id SERIAL PRIMARY KEY,
    site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    member_id INTEGER REFERENCES members(id) ON DELETE SET NULL,
    deductee_name VARCHAR(200) NOT NULL CHECK (length(trim(deductee_name)) > 0),
    pan VARCHAR(10) CHECK (pan ~ '^[A-Z]{5}[0-9]{4}[A-Z]$'),
    aadhaar VARCHAR(12) CHECK (aadhaar ~ '^[0-9]{12}$'),
    section VARCHAR(10) NOT NULL,
    deduction_date DATE NOT NULL,
    gross_amount NUMERIC(14,2) NOT NULL CHECK (gross_amount > 0),
    tds_rate NUMERIC(5,2) NOT NULL CHECK (tds_rate BETWEEN 0 AND 100),
    tds_amount NUMERIC(14,2) NOT NULL CHECK (tds_amount >= 0 AND tds_amount <= gross_amount),
    nature VARCHAR(200) NOT NULL DEFAULT '',
    deposit_date DATE CHECK (deposit_date >= deduction_date),
    challan_no VARCHAR(40),
    notes TEXT NOT NULL DEFAULT '' CHECK (length(notes) <= 2000),
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await database.query('CREATE INDEX IF NOT EXISTS tds_deductions_site_date_idx ON tds_deductions(site_id, deduction_date)');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  up().then(() => console.log('TDS register ready'))
    .catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => pool.end());
}
