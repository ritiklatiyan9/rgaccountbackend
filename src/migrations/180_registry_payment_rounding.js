import { pathToFileURL } from 'node:url';
import pool from '../config/db.js';

// Older imports sometimes saved the raw area × circle-rate product. Only
// round records whose saved amount still matches that product to the paisa.
// Other differences may be agreed consideration or stale source data.
export const candidateSql = `
  SELECT pr.id AS registry_id, pr.site_id,
         pr.registry_payment AS original_registry_payment,
         amount.rounded AS rounded_registry_payment,
         pr.size_meter AS original_size_meter,
         measurement.metres AS effective_size_meter,
         pr.circle_rate
    FROM plot_registries pr
    LEFT JOIN plots p ON p.id = pr.plot_id AND p.site_id = pr.site_id
    CROSS JOIN LATERAL (
      SELECT CASE
        WHEN p.plot_size_mtr > 0 THEN p.plot_size_mtr
        WHEN p.plot_size > 0 THEN ROUND(p.plot_size *
          CASE WHEN p.unit_type = 'flat' THEN 0.09290304 ELSE 0.8364 END, 4)
        ELSE pr.size_meter
      END AS metres
    ) measurement
    CROSS JOIN LATERAL (
      SELECT measurement.metres * pr.circle_rate AS raw,
             CEIL(measurement.metres * pr.circle_rate / 1000) * 1000 AS rounded
    ) amount
   WHERE measurement.metres > 0
     AND pr.circle_rate > 0
     AND pr.registry_payment > 0
     AND ABS(pr.registry_payment - amount.raw) <= 0.01
     AND amount.rounded > pr.registry_payment
     AND amount.rounded - pr.registry_payment < 1000
`;

export async function up(database = pool) {
  const client = await database.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('180_registry_payment_rounding'))");
    const existing = await client.query("SELECT 1 FROM app_schema_migrations WHERE version = '180_registry_payment_rounding'");
    if (existing.rows.length) {
      await client.query('COMMIT');
      return { updated: 0, skipped: true };
    }

    await client.query(`
      CREATE TABLE IF NOT EXISTS registry_payment_rounding_audit_180 (
        registry_id INTEGER PRIMARY KEY,
        site_id INTEGER NOT NULL,
        original_registry_payment NUMERIC(18,2) NOT NULL,
        rounded_registry_payment NUMERIC(18,2) NOT NULL,
        original_size_meter NUMERIC(18,4),
        effective_size_meter NUMERIC(18,4) NOT NULL,
        circle_rate NUMERIC(18,4) NOT NULL,
        corrected_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`
      INSERT INTO registry_payment_rounding_audit_180 (
        registry_id, site_id, original_registry_payment, rounded_registry_payment,
        original_size_meter, effective_size_meter, circle_rate
      ) ${candidateSql}
      ON CONFLICT (registry_id) DO NOTHING
    `);
    const updated = await client.query(`
      UPDATE plot_registries pr
         SET registry_payment = audit.rounded_registry_payment,
             updated_at = NOW()
        FROM registry_payment_rounding_audit_180 audit
       WHERE pr.id = audit.registry_id
         AND pr.site_id = audit.site_id
         AND pr.registry_payment = audit.original_registry_payment
         AND pr.registry_payment IS DISTINCT FROM audit.rounded_registry_payment
    `);
    await client.query("INSERT INTO app_schema_migrations(version) VALUES ('180_registry_payment_rounding') ON CONFLICT DO NOTHING");
    await client.query('COMMIT');
    return { updated: updated.rowCount, skipped: false };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  up().then(({ updated, skipped }) => console.log(skipped
    ? 'Registry payment rounding already applied'
    : `Rounded ${updated} legacy registry payments`))
    .catch(error => { console.error(error.message); process.exitCode = 1; })
    .finally(() => pool.end());
}
