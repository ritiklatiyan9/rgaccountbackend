// Read-only by default. Usage: node src/scripts/repairMissingPlotRegistries.mjs --site-id 5 [--apply]
import pool from '../config/db.js';
import { ensurePlotRegistryWorkspace } from '../services/plotRegistryWorkspace.service.js';

const args = process.argv.slice(2);
const siteId = Number(args[args.indexOf('--site-id') + 1]);
if (!args.includes('--site-id') || !Number.isSafeInteger(siteId) || siteId <= 0) {
  throw new Error('A positive --site-id is required. Use --apply only to create missing registry workspaces.');
}
try {
  const { rows } = await pool.query(`
    SELECT p.id, p.plot_no, p.buyer_name FROM plots p
    WHERE p.site_id = $1 AND UPPER(TRIM(p.status)) = 'REGISTRY'
      AND UPPER(TRIM(COALESCE(p.plot_tag, ''))) <> 'OLD'
      AND NOT EXISTS (
        SELECT 1 FROM plot_registries pr WHERE pr.site_id = p.site_id
          AND (pr.plot_id = p.id OR (pr.plot_id IS NULL AND UPPER(pr.plot_no) = UPPER(p.plot_no)))
      ) ORDER BY p.id`, [siteId]);
  console.log(JSON.stringify({ site_id: siteId, missing: rows, apply: args.includes('--apply') }));
  if (args.includes('--apply')) {
    // One transaction: no partially repaired batch if any entry cannot be created.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const results = [];
      for (const plot of rows) {
        // Recheck lifecycle under the same lock used by ordinary saves.
        const { rows: [current] } = await client.query(`SELECT id FROM plots WHERE id = $1 AND site_id = $2
          AND UPPER(TRIM(status)) = 'REGISTRY' AND UPPER(TRIM(COALESCE(plot_tag, ''))) <> 'OLD'
          FOR UPDATE`, [plot.id, siteId]);
        if (!current) continue;
        const result = await ensurePlotRegistryWorkspace(client, plot.id);
        results.push({ plot_no: plot.plot_no, registry_id: result.registry.id, created: result.created });
      }
      await client.query('COMMIT');
      console.log(JSON.stringify({ repaired: results }));
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
} finally {
  await pool.end();
}
