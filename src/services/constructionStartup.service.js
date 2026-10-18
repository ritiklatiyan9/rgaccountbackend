import pool from '../config/db.js';
import { up as portfolio } from '../migrations/141_construction_portfolio_structure.js';
import { up as workflow } from '../migrations/219_construction_workflow.js';
import { up as integrity } from '../migrations/220_construction_payment_integrity.js';

export const constructionStartupMigrations = Object.freeze([
  ['141_construction_portfolio_structure', portfolio],
  ['219_construction_workflow', workflow],
  ['220_construction_payment_integrity', integrity],
]);

// All server entry points must install the same prerequisites before accepting
// requests. Installed versions are skipped to avoid rebuilding guards/locking
// financial tables at every boot. Failed migrations retain their rollback and
// stop startup; never serve a partially upgraded workflow.
export async function ensureConstructionStartup(database = pool, migrations = constructionStartupMigrations) {
  const { rows } = await database.query(
    'SELECT version FROM app_schema_migrations WHERE version=ANY($1::text[])',
    [migrations.map(([version]) => version)],
  );
  const installed = new Set(rows.map(row => row.version));
  const applied = [];
  for (const [version, migrate] of migrations) {
    if (installed.has(version)) continue;
    await migrate(database);
    applied.push(version);
  }
  return { applied, current: applied.length === 0 };
}
