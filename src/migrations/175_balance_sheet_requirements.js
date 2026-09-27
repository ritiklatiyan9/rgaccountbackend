import { pathToFileURL } from 'node:url';
import pool from '../config/db.js';

export async function up(database = pool) {
  // Preparation metadata only; no financial records or posting rules change.
  await database.query(`CREATE TABLE IF NOT EXISTS balance_sheet_requirements (
    site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    financial_year INTEGER NOT NULL CHECK (financial_year BETWEEN 1900 AND 2099),
    requirement VARCHAR(40) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','in_progress','complete','not_applicable')),
    notes TEXT NOT NULL DEFAULT '' CHECK (length(notes)<=4000),
    updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (site_id, financial_year, requirement)
  )`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  up().then(() => console.log('Year-end requirements checklist ready'))
    .catch(error => { console.error(error.message); process.exitCode=1; }).finally(() => pool.end());
}
