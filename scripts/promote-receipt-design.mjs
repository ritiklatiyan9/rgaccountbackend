// One-time activation. Original site settings are backed up before any change.
import fs from 'node:fs/promises';
import path from 'node:path';
import pool from '../src/config/db.js';
import { normalizeReceiptDesign, RECEIPT_DESIGN_KEY } from '../src/services/receiptDesign.service.js';
const apply = process.argv.includes('--apply');
const client = await pool.connect();
try {
  await client.query('BEGIN');
  await client.query("SELECT pg_advisory_xact_lock(hashtext('shared-receipt-design'))");
  const { rows } = await client.query('SELECT * FROM application_settings WHERE setting_key=$1 ORDER BY id', [RECEIPT_DESIGN_KEY]);
  const { rows: sites } = await client.query('SELECT id, name FROM sites ORDER BY id');
  const source = sites.find(site => site.name.trim().toUpperCase() === 'OM ASSOCIATES');
  if (!source) throw new Error('OM ASSOCIATES was not found.');
  const original = rows.find(row => row.site_id === source.id);
  if (!original) throw new Error('OM ASSOCIATES has no saved receipt design.');
  const existing = rows.find(row => row.site_id === null);
  if (existing) { console.log('A shared design already exists; no settings changed.'); await client.query('ROLLBACK'); }
  else if (!apply) { console.log(`Ready to apply the saved OM ASSOCIATES formats to ${sites.length} sites. Run with --apply to activate.`); await client.query('ROLLBACK'); }
  else {
    const folder = path.resolve('outputs/receipt-studio'); await fs.mkdir(folder, { recursive: true });
    const backup = path.join(folder, `settings-before-${Date.now()}.json`);
    await fs.writeFile(backup, JSON.stringify({ setting_key: RECEIPT_DESIGN_KEY, sites, settings: rows }, null, 2), { flag: 'wx' });
    const design = JSON.stringify(normalizeReceiptDesign(original.setting_value));
    await client.query(`INSERT INTO application_settings (site_id, setting_key, setting_value, updated_by, updated_at)
      VALUES (NULL,$1,$2::jsonb,$3,NOW())`, [RECEIPT_DESIGN_KEY, design, original.updated_by]);
    // Keep the current hosted version visually consistent during the backend rollout.
    for (const site of sites) await client.query(`INSERT INTO application_settings (site_id,setting_key,setting_value,updated_by,updated_at)
      VALUES ($1,$2,$3::jsonb,$4,NOW()) ON CONFLICT (site_id,setting_key) DO UPDATE SET setting_value=EXCLUDED.setting_value,updated_by=EXCLUDED.updated_by,updated_at=NOW()`,
      [site.id,RECEIPT_DESIGN_KEY,design,original.updated_by]);
    await client.query('COMMIT');
    console.log(`OM ASSOCIATES receipt formats activated globally and for ${sites.length} existing sites. Backup: ${backup}`);
  }
} catch (error) { await client.query('ROLLBACK'); throw error; }
finally { client.release(); await pool.end(); }
