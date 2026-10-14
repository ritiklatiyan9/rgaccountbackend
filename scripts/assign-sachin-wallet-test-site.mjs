import { open } from 'node:fs/promises';
import pool from '../src/config/db.js';
import { repairWalletTransferSite } from '../src/services/walletSiteAttributionRepair.service.js';

const usage = 'node scripts/assign-sachin-wallet-test-site.mjs [--apply] [--output /absolute/report.json]';
let reportFile, completedReport;
try {
  const args = process.argv.slice(2);
  if (args.includes('--help')) { console.log(`${usage}\nDry-run is the default. --apply requires --output; a separate .before.json snapshot is fsynced before mutation.`); }
  else {
    let apply = false, output;
    for (let index = 0; index < args.length; index += 1) {
      const argument = args[index];
      if (argument === '--apply' && !apply) apply = true;
      else if (argument === '--output' && !output && args[index + 1] && !args[index + 1].startsWith('--')) output = args[++index];
      else throw new Error(`Unknown or duplicate argument: ${argument}. ${usage}`);
    }
    if (apply && !output) throw new Error('--apply requires --output to preserve the before snapshot and result.');
    // Reserve an unused output path before entering the database transaction.
    if (output) reportFile = await open(output, 'wx', 0o600);
    const report = await repairWalletTransferSite(pool, { apply, beforeSnapshotWriter: async before => {
      const file = await open(`${output}.before.json`, 'wx', 0o600);
      try { await file.writeFile(`${JSON.stringify(before, null, 2)}\n`); await file.sync(); }
      finally { await file.close(); }
    } });
    completedReport = report;
    if (reportFile) { await reportFile.writeFile(`${JSON.stringify(report, null, 2)}\n`); await reportFile.sync(); }
    console.log(JSON.stringify({ status: report.status, applied: report.applied, repair_key: report.repair.repairKey,
      transfer_id: report.repair.transferId, site_id: report.repair.siteId, output: output || null,
      ...(output ? {} : { report }) }, null, 2));
  }
} catch (error) {
  console.error(JSON.stringify({ error: error.code || error.name, message: error.message,
    ...(completedReport ? { database_status: completedReport.status, applied: completedReport.applied } : {}) }));
  process.exitCode = 1;
} finally { await reportFile?.close(); await pool.end(); }
