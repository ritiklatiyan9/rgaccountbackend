import 'dotenv/config';
import pkg from 'pg';
const { Pool } = pkg;

const pool = new Pool({
  host: process.env.DB_HOST,
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: String(process.env.DB_PASSWORD || ''),
  ssl: process.env.DB_SSL === 'true' || (process.env.DB_HOST && process.env.DB_HOST.includes('neon'))
    ? { rejectUnauthorized: false }
    : false,
});

async function run() {
  await pool.query(`
    ALTER TABLE expenses ADD COLUMN IF NOT EXISTS bill_urls TEXT[];
    UPDATE expenses
       SET bill_urls = ARRAY[bill_url]
     WHERE bill_url IS NOT NULL AND bill_url <> '' AND bill_urls IS NULL;
  `);
  console.log('DONE: expenses.bill_urls added and backfilled from bill_url');
  await pool.end();
}

run().catch(e => { console.error('ERR:', e.message); pool.end(); });
