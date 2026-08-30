import 'dotenv/config';
import pool from '../config/db.js';

/**
 * Let PostgreSQL push a caller's site/date predicates into the ledger source.
 *
 * ledger_entries has three UNION branches over the same `base` CTE. PostgreSQL
 * therefore materializes that CTE by default, which made even a one-day query
 * scan and join the complete cash_flow_entries history before discarding rows.
 * NOT MATERIALIZED trades a small amount of repeated planning for indexed
 * source scans in each branch. The view's columns and accounting rules remain
 * unchanged.
 *
 * The migration transforms PostgreSQL's own current view definition so future
 * accounting-view additions do not have to be duplicated here.
 */
const migrate = async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('122_ledger_entries_not_materialized'))`);

    const result = await client.query(
      `SELECT pg_get_viewdef('public.ledger_entries'::regclass, true) AS definition`
    );
    const original = result.rows[0]?.definition;
    if (!original) throw new Error('ledger_entries view is missing');

    let optimized = original.replace(/;\s*$/, '');
    let changed = 0;
    for (const cte of ['raw_base', 'base', 'posted']) {
      const materializedByDefault = new RegExp(`(\\b${cte}\\s+AS)\\s*\\(`, 'i');
      const alreadyOptimized = new RegExp(`\\b${cte}\\s+AS\\s+NOT\\s+MATERIALIZED\\s*\\(`, 'i');
      if (materializedByDefault.test(optimized)) {
        optimized = optimized.replace(materializedByDefault, '$1 NOT MATERIALIZED (');
        changed += 1;
      } else if (!alreadyOptimized.test(optimized)) {
        throw new Error(`Could not locate the ${cte} CTE in ledger_entries`);
      }
    }

    if (changed > 0) {
      await client.query(`CREATE OR REPLACE VIEW ledger_entries AS ${optimized}`);
    }

    await client.query('COMMIT');
    console.log(`Migration 122_ledger_entries_not_materialized complete (${changed} CTEs updated)`);
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Migration 122_ledger_entries_not_materialized failed:', error.message);
    throw error;
  } finally {
    client.release();
  }
};

migrate()
  .then(() => process.exit(0))
  .catch(() => process.exit(1));
