import { pathToFileURL } from 'node:url';
import pool from '../config/db.js';
import { workspaceFunctionSql } from './174_registered_plot_workspace.js';

// Replace the function installed by 174 on databases that already ran it.
// Cash links created in the same transaction as an automatic workspace can
// be identified without confusing them with later, manually chosen links.
export const migrationSql = `
${workspaceFunctionSql}

DELETE FROM plot_registry_payments prp
USING plot_registries pr, plot_payments pp
WHERE prp.registry_id = pr.id
  AND prp.source_plot_payment_id = pp.id
  AND COALESCE(NULLIF(UPPER(TRIM(pp.payment_type)), ''), 'CASH') = 'CASH'
  AND pr.notes IN (
    'Registry workspace created automatically from Plot Payments REGISTRY status.',
    'NOC workspace draft created automatically from Plot Payments.'
  )
  AND pr.noc_generated_at IS NULL
  AND pr.noc_approved_at IS NULL
  AND pr.registry_date IS NULL
  AND prp.created_at = pr.created_at;
`;

export async function up(database = pool) {
  const client = await database.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('178_registry_cash_links_manual'))");
    const { rows } = await client.query("SELECT 1 FROM app_schema_migrations WHERE version = '178_registry_cash_links_manual'");
    if (!rows.length) {
      await client.query(migrationSql);
      await client.query("INSERT INTO app_schema_migrations(version) VALUES ('178_registry_cash_links_manual')");
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  up().then(() => console.log('Registry cash receipts now require a manual link'))
    .catch(error => { console.error(error.message); process.exitCode = 1; })
    .finally(() => pool.end());
}
