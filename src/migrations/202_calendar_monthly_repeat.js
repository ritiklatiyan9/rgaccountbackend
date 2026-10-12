import { pathToFileURL } from 'node:url';
import pool from '../config/db.js';

export async function up(db = pool) {
  await db.query(`ALTER TABLE compliance_templates ADD COLUMN IF NOT EXISTS calendar_event_defaults JSONB NOT NULL DEFAULT '{}'::jsonb`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  up().then(() => console.log('Migration 202: monthly calendar event defaults ready'))
    .catch(error => { console.error('Migration 202 failed:', error.message); process.exitCode = 1; })
    .finally(() => pool.end());
}
