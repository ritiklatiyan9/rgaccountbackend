// Read-only schema/data smoke check. Prints counts and timings, never exported records.
import pool from '../src/config/db.js';
import { buildModuleDriveShareBundle, listModuleDriveDefinitions } from '../src/services/moduleDriveShare.service.js';
import { buildModuleShareXlsx } from '../src/services/driveShareWorkbook.service.js';

pool.query = async (sql, args) => {
  if (typeof sql !== 'string' || !/^\s*(SELECT|WITH)\b/i.test(sql)) throw new Error('This verification command permits read queries only');
  const client = await pool.connect();
  try {
    await client.query('BEGIN READ ONLY');
    const result = await client.query(sql, args);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
};
try {
  const { rows: [user] } = await pool.query("SELECT id,role,name,email,organization_id FROM users WHERE role='admin' AND is_active=TRUE ORDER BY id LIMIT 1");
  if (!user) throw new Error('No active administrator available for the export check');
  const { rows: [site] } = await pool.query('SELECT s.id FROM sites s WHERE organization_id=$1 ORDER BY (SELECT COUNT(*) FROM plot_payments p WHERE p.site_id=s.id) DESC,s.id LIMIT 1', [user.organization_id]);
  if (!site) throw new Error('No site available for the export check');
  let failures = 0;
  const selectedModules = new Set(process.argv.slice(2));
  for (const definition of listModuleDriveDefinitions().filter((entry) => !selectedModules.size || selectedModules.has(entry.key))) {
    const started = performance.now();
    try {
      const bundle = await buildModuleDriveShareBundle({ moduleKey: definition.key, siteId: site.id, user });
      const rendered = performance.now();
      const bytes = buildModuleShareXlsx(bundle);
      const populatedColumns = bundle.sheets.map((sheet) => ({ sheet: sheet.name, rows: sheet.rows.length,
        populated_columns: sheet.columns.filter(({ key }) => sheet.rows.some((row) => row[key] != null && row[key] !== '')).length,
        columns: sheet.columns.length }));
      process.stdout.write(`${JSON.stringify({ module: definition.key, status: 'ok', records: bundle.summary.record_count, documents: bundle.documents.length,
        available_document_links: bundle.documents.filter((doc) => doc.url && doc.linkVersion).length,
        unavailable_reasons: bundle.documents.reduce((counts, doc) => { if (doc.unavailable) counts[doc.unavailable] = (counts[doc.unavailable] || 0) + 1; return counts; }, {}),
        read_ms: Math.round(rendered - started), excel_ms: Math.round(performance.now() - rendered), bytes: bytes.length, sheets: populatedColumns })}\n`);
    } catch (error) {
      failures += 1;
      const schemaError = ['42703', '42P01', '42883', '42P18'].includes(error.code) || error instanceof TypeError ? error.message : undefined;
      process.stdout.write(`${JSON.stringify({ module: definition.key, status: 'failed', code: error.code || error.statusCode || 'EXPORT_ERROR', schema_error: schemaError })}\n`);
    }
  }
  if (failures) process.exitCode = 1;
} finally { await pool.end(); }
