import fs from 'node:fs/promises';
import path from 'node:path';
import pool from '../config/db.js';
import { writeAuditLog } from '../services/auditLog.service.js';

const SITE_ID = 2;
const ORG_ID = 1;
const ACTOR_ID = 1;
const MARKER = 'AI_RECON_TEST_2026_08 — Mount Valley Residency reconciliation fixture';
const outputDir = path.resolve('outputs/mount-valley-ai-recon');
const snapshotPath = path.join(outputDir, 'mount-valley-ai-recon-before.json');
const manifestPath = path.join(outputDir, 'mount-valley-ai-recon-manifest.json');

const cases = [
  [1, 15, 'B8', 'AMIT PAL', 'RAKESH KUMAR', '123456', '500000.00', '2026-08-18', '4412', ['RK', 'R KUMAR']],
  [2, 809, 'B1', 'DHANPAL', 'SANA TRADERS', '654321', '250000.00', '2026-08-19', '4412', ['SANA TRD']],
  [3, 810, 'A10', 'DHANPAL', 'MOHIT TYAGI', '000778', '375000.00', '2026-08-20', '4412', ['MOHIT TYG', 'M TYAGI']],
  [4, 813, 'B99', 'RAVI SIWACH', 'AMIT TOMAR', '445566', '625000.00', '2026-08-20', '4412', ['A TOMAR', 'AMIT TMR']],
  [5, 459, 'A4', 'ABHINAV SEHRAWAT', 'PRIYA DEVELOPERS', '998877', '1200000.00', '2026-08-21', '4412', ['PDS INFRA', 'PRIYA DEV', 'PDS INFRA PRIVATE LIMITED']],
  [6, 811, 'A99', 'ARJIT MALIK', 'ARJUN MALIK', '112233', '825000.00', '2026-08-22', '9081', ['A MALIK', 'MALIK FAMILY', 'SURESH MALIK']],
  [7, 5, 'B5', 'RAKESH KUMAR', 'KAVITA JAIN', '333444', '450000.00', '2026-08-23', '7710', ['K JAIN', 'KAVITA J']],
  [8, 2, 'A2', 'RISHAB BHARADWAJ', 'RAHUL CHAUDHARY', '556677', '450000.00', '2026-08-24', '6624', ['RL CHDY', 'R CHAUDHARY']],
  [9, 6, 'A6', 'ARJIT MALIK', 'OM ASSOCIATES', '246810', '310000.00', '2026-08-25', '4412', ['OM ASSOC']],
].map(([fixtureNo, plotId, plotNo, oldCustomer, customer, chequeNo, amount, date, suffix, aliases]) => ({
  fixtureNo, plotId, plotNo, oldCustomer, customer, chequeNo, amount, date, suffix, aliases,
  seedKey: `AI_RECON_TEST_2026_08_MV-BNK-${String(fixtureNo).padStart(4, '0')}`,
}));

async function captureBefore(client) {
  const ids = cases.map((item) => item.plotId);
  const site = await client.query('SELECT * FROM sites WHERE id = $1 AND organization_id = $2', [SITE_ID, ORG_ID]);
  const plots = await client.query('SELECT * FROM plots WHERE id = ANY($1::int[]) ORDER BY id', [ids]);
  const payments = await client.query('SELECT * FROM plot_payments WHERE plot_id = ANY($1::int[]) ORDER BY id', [ids]);
  const registries = await client.query(`SELECT pr.* FROM plot_registries pr JOIN plots p ON p.site_id=pr.site_id AND (pr.plot_id=p.id OR (pr.plot_id IS NULL AND UPPER(pr.plot_no)=UPPER(p.plot_no))) WHERE p.id=ANY($1::int[]) ORDER BY pr.id`, [ids]);
  const installments = await client.query('SELECT * FROM plot_installments WHERE plot_id = ANY($1::int[]) ORDER BY id', [ids]);
  if (site.rowCount !== 1 || plots.rowCount !== 9) throw new Error('Mount Valley tenant/plot preflight failed');
  for (const item of cases) {
    const plot = plots.rows.find((row) => row.id === item.plotId);
    if (!plot || plot.site_id !== SITE_ID || plot.plot_no !== item.plotNo || plot.status !== 'BOOKED' || plot.buyer_name !== item.oldCustomer) {
      throw new Error(`Preflight mismatch for case ${item.fixtureNo} / plot ${item.plotId}`);
    }
  }
  return { captured_at: new Date().toISOString(), organization_id: ORG_ID, site_id: SITE_ID, marker: MARKER, cases, site: site.rows[0], plots: plots.rows, payments: payments.rows, registries: registries.rows, installments: installments.rows };
}

async function seed() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE');
    const existing = await client.query(`SELECT seed_key FROM bank_reconciliation_candidate_metadata WHERE organization_id=$1 AND site_id=$2 AND seed_key=ANY($3::text[])`, [ORG_ID, SITE_ID, cases.map((x) => x.seedKey)]);
    if (existing.rowCount) throw new Error('Fixture metadata already exists; refusing a duplicate seed');
    const before = await captureBefore(client);
    await fs.mkdir(outputDir, { recursive: true });
    await fs.writeFile(snapshotPath, `${JSON.stringify(before, null, 2)}\n`, 'utf8');

    const created = [];
    for (const item of cases) {
      const locked = await client.query('SELECT * FROM plots WHERE id=$1 AND site_id=$2 FOR UPDATE', [item.plotId, SITE_ID]);
      const oldPlot = locked.rows[0];
      const nextNotes = oldPlot.notes ? `${oldPlot.notes}\n${MARKER}` : MARKER;
      const updated = await client.query('UPDATE plots SET buyer_name=$1, notes=$2, updated_at=NOW() WHERE id=$3 AND site_id=$4 RETURNING *', [item.customer, nextNotes, item.plotId, SITE_ID]);
      const narration = `${MARKER} | MV-BNK-${String(item.fixtureNo).padStart(4, '0')} | BANK LAST4 ${item.suffix} | ALIASES: ${item.aliases.join('; ')}`;
      const payment = await client.query(`INSERT INTO plot_payments (plot_id,site_id,date,payment_from,payment_type,bank_details,narration,amount,created_by,status,cheque_no,cheque_status,buyer_name,booked_by) SELECT p.id,p.site_id,$1::date,$2,'CHEQUE',$3,$4,$5::numeric,$6,'pending',$7,'PENDING',p.buyer_name,p.booking_by FROM plots p WHERE p.id=$8 AND p.site_id=$9 RETURNING *`, [item.date, item.customer, `ACCOUNT ENDING ${item.suffix}`, narration, item.amount, ACTOR_ID, item.chequeNo, item.plotId, SITE_ID]);
      const row = payment.rows[0];
      if (!row) throw new Error(`Payment insert failed for case ${item.fixtureNo}`);
      await client.query(`UPDATE cash_flow_entries SET cheque_no=$1,cheque_status='PENDING',updated_at=NOW() WHERE source_module='plot_payments' AND source_id=$2 AND site_id=$3`, [item.chequeNo, row.id, SITE_ID]);
      await client.query(`INSERT INTO bank_reconciliation_candidate_metadata (organization_id,site_id,entity_source,entity_entry_id,payer_names,booking_reference,plot_reference,account_suffix,seed_key,created_by) VALUES ($1,$2,'plot_payment',$3,$4::jsonb,$5,$6,$7,$8,$9)`, [ORG_ID, SITE_ID, row.id, JSON.stringify([item.customer, ...item.aliases]), String(item.plotId), item.plotNo, item.suffix, item.seedKey, ACTOR_ID]);
      for (const alias of item.aliases) await client.query(`INSERT INTO bank_reconciliation_aliases (organization_id,site_id,entity_source,entity_entry_id,alias_value,normalized_alias,created_by) VALUES ($1,$2,'plot_payment',$3,$4,$5,$6)`, [ORG_ID, SITE_ID, row.id, alias, alias.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(), ACTOR_ID]);
      await writeAuditLog({ organizationId: ORG_ID, siteId: SITE_ID, userId: ACTOR_ID, action: 'UPDATE', eventType: 'FIXTURE', module: 'plot_payments', entityType: 'plot', entityId: item.plotId, description: `Applied ${item.seedKey}`, oldValues: { buyer_name: oldPlot.buyer_name, notes: oldPlot.notes }, newValues: { buyer_name: updated.rows[0].buyer_name, notes: updated.rows[0].notes }, metadata: { marker: MARKER } }, client);
      await writeAuditLog({ organizationId: ORG_ID, siteId: SITE_ID, userId: ACTOR_ID, action: 'CREATE', eventType: 'FIXTURE', module: 'plot_payments', transactionName: item.customer, amount: Number(item.amount), entityType: 'plot_payment', entityId: row.id, description: `Created pending cheque ${item.seedKey}`, newValues: row, metadata: { marker: MARKER, seed_key: item.seedKey } }, client);
      created.push({ fixture_no: item.fixtureNo, plot_id: item.plotId, plot_no: item.plotNo, old_customer: item.oldCustomer, new_customer: item.customer, payment_id: row.id, cheque_no: row.cheque_no, amount: row.amount, date: row.date, status: row.status, cheque_status: row.cheque_status, seed_key: item.seedKey });
    }
    await fs.writeFile(manifestPath, `${JSON.stringify({ created_at: new Date().toISOString(), snapshot_path: snapshotPath, marker: MARKER, created }, null, 2)}\n`, 'utf8');
    await client.query('COMMIT');
    console.log(JSON.stringify({ snapshotPath, manifestPath, created }, null, 2));
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); await pool.end(); }
}

async function rollback() {
  const [snapshot, manifest] = await Promise.all([fs.readFile(snapshotPath, 'utf8').then(JSON.parse), fs.readFile(manifestPath, 'utf8').then(JSON.parse)]);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const item of manifest.created) {
      const current = await client.query('SELECT * FROM plot_payments WHERE id=$1 AND plot_id=$2 AND site_id=$3 FOR UPDATE', [item.payment_id, item.plot_id, SITE_ID]);
      const row = current.rows[0];
      if (!row || row.status !== 'pending' || row.cheque_status !== 'PENDING' || row.cheque_no !== item.cheque_no) throw new Error(`Unsafe rollback state for payment ${item.payment_id}`);
      const link = await client.query('SELECT 1 FROM bank_reconciliation_links WHERE candidate_source=\'plot_payment\' AND candidate_entry_id=$1', [item.payment_id]);
      if (link.rowCount) throw new Error(`Payment ${item.payment_id} has a reconciliation link`);
      await client.query("DELETE FROM bank_reconciliation_aliases WHERE organization_id=$1 AND site_id=$2 AND entity_source='plot_payment' AND entity_entry_id=$3", [ORG_ID, SITE_ID, item.payment_id]);
      await client.query("DELETE FROM bank_reconciliation_candidate_metadata WHERE organization_id=$1 AND site_id=$2 AND entity_source='plot_payment' AND entity_entry_id=$3 AND seed_key=$4", [ORG_ID, SITE_ID, item.payment_id, item.seed_key]);
      await client.query('DELETE FROM plot_payments WHERE id=$1', [item.payment_id]);
      const old = snapshot.plots.find((p) => p.id === item.plot_id);
      await client.query('UPDATE plots SET buyer_name=$1,notes=$2,updated_at=$3 WHERE id=$4 AND site_id=$5', [old.buyer_name, old.notes, old.updated_at, old.id, SITE_ID]);
    }
    await writeAuditLog({ organizationId: ORG_ID, siteId: SITE_ID, userId: ACTOR_ID, action: 'DELETE', eventType: 'FIXTURE', module: 'plot_payments', entityType: 'fixture', entityId: MARKER, description: 'Rolled back Mount Valley AI reconciliation fixture', metadata: { payment_ids: manifest.created.map((x) => x.payment_id) } }, client);
    await client.query('COMMIT');
    console.log(JSON.stringify({ rolled_back: manifest.created.map((x) => x.payment_id) }, null, 2));
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); await pool.end(); }
}

(process.argv.includes('--rollback') ? rollback() : seed()).catch((error) => { console.error(error); process.exitCode = 1; });
