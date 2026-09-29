import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { ensurePlotRegistryWorkspace } from '../src/services/plotRegistryWorkspace.service.js';
import { plotModel } from '../src/models/Plot.model.js';
import { migrationSql as registeredPlotWorkspaceSql } from '../src/migrations/174_registered_plot_workspace.js';
import { migrationSql as manualCashLinksSql } from '../src/migrations/178_registry_cash_links_manual.js';
import { registryPaymentFromMetres, registryMetresFromGaz } from '../src/utils/registryPayment.js';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');

// In-memory PostgreSQL only. No application credentials or real NOC records.
test('registry workspaces stay atomic across NOC drafts, status edits, imports and resales', { skip: !process.env.PGLITE_MODULE }, async () => {
  const { PGlite } = await import(process.env.PGLITE_MODULE);
  const db = new PGlite();
  try {
    await db.exec(`
      CREATE TABLE app_schema_migrations(version text PRIMARY KEY);
      CREATE TABLE sites(id integer PRIMARY KEY, name text);
      CREATE TABLE plots(id integer PRIMARY KEY, site_id integer, plot_no text, buyer_name text,
        plot_size numeric, plot_size_mtr numeric, circle_rate numeric, to_receive_bank numeric,
        assigned_admin_id integer, status text, plot_tag text);
      CREATE TABLE members(id integer PRIMARY KEY, site_id integer, full_name text);
      CREATE TABLE bookings(id integer PRIMARY KEY, site_id integer, plot_id integer,
        client_member_id integer, status text);
      CREATE TABLE plot_payments(id integer PRIMARY KEY, plot_id integer, site_id integer, date date,
        amount numeric, payment_type text, payment_from text, bank_details text, narration text,
        cheque_no text, cheque_status text, status text, approved_by integer, approved_at timestamptz,
        created_at timestamptz DEFAULT now());
      CREATE TABLE plot_registries(id serial PRIMARY KEY, site_id integer, plot_id integer UNIQUE,
        plot_no text, customer_name text, size_meter numeric, size_sqyard numeric, circle_rate numeric,
        created_entry_date date, registry_date date, bank_amount numeric, registry_payment numeric, notes text,
        assigned_admin_id integer, created_by integer, noc_generated_at timestamptz,
        noc_approved_at timestamptz, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());
      CREATE TABLE plot_registry_payments(id serial PRIMARY KEY, registry_id integer, site_id integer,
        payment_date date, amount numeric, payment_mode text, tally_date date, tally_amount numeric,
        notes text, source_plot_payment_id integer UNIQUE, include_in_noc boolean, cheque_no text,
        cheque_status text, status text, approved_by integer, approved_at timestamptz, created_by integer,
        created_at timestamptz DEFAULT now());
      INSERT INTO sites VALUES (5, 'Test project');
      INSERT INTO members VALUES (34, 5, 'Client Name');
      INSERT INTO bookings VALUES (1, 5, 438, 34, 'BOOKED');
      INSERT INTO plots VALUES (438, 5, 'A38', 'Test Buyer', 100, 83.61, 15000, 1000, 7, 'BOOKED', 'NEW'),
        (439, 5, 'A39', 'Other Buyer', 200, 167.22, 15000, 2000, 7, 'BOOKED', 'OLD');
      INSERT INTO plot_payments(id,plot_id,site_id,date,amount,payment_type,status,cheque_status) VALUES
        (1,438,5,'2026-09-01',1000,'CASH','approved',NULL),
        (2,438,5,'2026-09-02',200,'CHEQUE','approved','CLEARED'),
        (3,438,5,'2026-09-03',500,'CHEQUE','approved','PENDING'),
        (4,438,5,'2026-09-04',600,'CASH','rejected',NULL),
        (5,439,5,'2026-09-01',700,'CASH','approved',NULL);
    `);
    const postingSql = read('../src/migrations/118_credit_first_posting.js').match(/CREATE OR REPLACE FUNCTION financial_transaction_posts\([\s\S]+?\$\$\s*`/)[0].slice(0, -1);
    await db.exec(postingSql);
    let failMapping = false;
    const query = async (sql, params) => {
      if (failMapping && sql.includes('INSERT INTO plot_registry_payments')) throw new Error('Mapping unavailable');
      const result = await db.query(sql, params);
      return { ...result, rowCount: result.affectedRows ?? result.rows.length };
    };
    const pool = { query, connect: async () => ({ query, release() {} }), end: async () => {} };
    const source = read('../src/controllers/plot.controller.js').replace(/^import[\s\S]*?;\n/gm, '').replace(/export const /g, 'const ');
    const ctx = vm.createContext({ pool, asyncHandler: fn => fn, console, ensurePlotRegistryWorkspace, registryPaymentFromMetres, registryMetresFromGaz });
    vm.runInContext(`${source}\nthis.handlers = { getPlotNocRegistry, createPlotNocRegistry };`, ctx);
    const invoke = async (name, id = 438) => {
      let status = 200, body;
      await ctx.handlers[name]({ params: { id }, user: { id: 7 } }, {
        status(code) { status = code; return this; }, json(value) { body = value; return this; },
      });
      return { status, body };
    };
    const rows = async table => (await db.query(`SELECT * FROM ${table} ORDER BY id`)).rows;
    const before = { plots: await rows('plots'), payments: await rows('plot_payments') };
    const firstLookup = await invoke('getPlotNocRegistry');
    assert.equal(firstLookup.status, 200);
    assert.equal(firstLookup.body.registry, null);
    assert.equal(firstLookup.body.requires_creation, true);
    assert.equal((await rows('plot_registries')).length, 0, 'GET must not create a draft');
    assert.equal((await invoke('getPlotNocRegistry', 999)).status, 404);
    assert.equal((await invoke('createPlotNocRegistry', 999)).body.code, 'PLOT_NOT_FOUND');
    assert.equal((await invoke('createPlotNocRegistry', 439)).status, 400);

    failMapping = true;
    await assert.rejects(invoke('createPlotNocRegistry'), /Mapping unavailable/);
    assert.equal((await rows('plot_registries')).length, 0, 'failed mappings roll back the draft');
    failMapping = false;
    const created = await invoke('createPlotNocRegistry');
    assert.equal(created.status, 201);
    assert.equal(Number(created.body.registry.registry_payment), 1255000);
    assert.equal(Number((await rows('plot_registries'))[0].size_meter), 83.61);
    assert.equal((await rows('plot_registries'))[0].customer_name, 'TEST BUYER');
    assert.equal(Number((await rows('plot_registries'))[0].size_sqyard), 100, 'legacy schema defaults to plots');
    assert.deepEqual((await rows('plot_registry_payments')).map(p => p.source_plot_payment_id), [2],
      'approved cash stays available for a manual link');
    const repeat = await invoke('createPlotNocRegistry');
    assert.equal(repeat.body.created, false);
    assert.equal(repeat.body.registry.id, created.body.registry.id);
    assert.equal((await rows('plot_registries')).length, 1);
    assert.equal((await invoke('getPlotNocRegistry')).body.registry.id, created.body.registry.id);
    assert.deepEqual({ plots: await rows('plots'), payments: await rows('plot_payments') }, before);

    // A direct status edit (NOC optional) used to persist REGISTRY without a
    // registry row. Both it and approved edits use the real PlotModel.update.
    await db.query(`INSERT INTO plots(id,site_id,plot_no,buyer_name,plot_size,plot_size_mtr,circle_rate,status,plot_tag)
      VALUES (441,5,'A40','Current Buyer',100,83.61,15000,'BOOKED','NEW'),
             (442,5,'A41','Approved Buyer',100,83.61,15000,'BOOKED','NEW'),
             (443,5,'A42','Metadata Buyer',100,83.61,15000,'BOOKED','NEW')`);
    await db.query(`INSERT INTO plot_payments(id,plot_id,site_id,date,amount,payment_type,status)
      VALUES (6,441,5,'2026-09-01',400,'CASH','approved'),
             (7,442,5,'2026-09-01',500,'CASH','approved'),
             (11,441,5,'2026-09-01',400,'BANK','approved')`);
    const sourcePayments = await rows('plot_payments');
    failMapping = true;
    await assert.rejects(plotModel.update(441, { status: 'REGISTRY' }, pool), /Mapping unavailable/);
    assert.equal((await rows('plots')).find(p => p.id === 441).status, 'BOOKED', 'status rolls back with failed registry mapping');
    assert.equal((await rows('plot_registries')).some(r => r.plot_id === 441), false);
    failMapping = false;
    await plotModel.update(441, { status: 'REGISTRY' }, pool);
    const registered = (await rows('plot_registries')).find(r => r.plot_id === 441);
    assert.equal(registered.customer_name, 'CURRENT BUYER');
    assert.equal(registered.noc_generated_at, null);
    assert.equal(registered.noc_approved_at, null);
    assert.equal((await rows('plots')).find(p => p.id === 441).status, 'REGISTRY');
    assert.deepEqual((await rows('plot_registry_payments')).filter(r => r.registry_id === registered.id)
      .map(r => r.source_plot_payment_id), [11], 'direct status edit links bank but leaves cash unlinked');
    const mappedCount = (await rows('plot_registry_payments')).length;
    await plotModel.update(441, { status: 'REGISTRY' }, pool);
    assert.equal((await rows('plot_registries')).filter(r => r.plot_id === 441).length, 1);
    assert.equal((await rows('plot_registry_payments')).length, mappedCount, 'repeat save does not duplicate receipts');

    // Approval already owns a transaction. The model must not commit it early.
    const approvalClient = await pool.connect();
    await approvalClient.query('BEGIN');
    await plotModel.update(442, { status: 'REGISTRY' }, approvalClient);
    await approvalClient.query('ROLLBACK');
    assert.equal((await rows('plots')).find(p => p.id === 442).status, 'BOOKED');
    assert.equal((await rows('plot_registries')).some(r => r.plot_id === 442), false);
    await approvalClient.query('BEGIN');
    await plotModel.update(442, { status: 'REGISTRY' }, approvalClient);
    await approvalClient.query('COMMIT');
    assert.equal((await rows('plot_registries')).find(r => r.plot_id === 442).customer_name, 'APPROVED BUYER');
    assert.equal((await rows('plot_registry_payments')).some(r => r.source_plot_payment_id === 7), false);
    await plotModel.update(443, { buyer_name: 'Edited Buyer' }, pool);
    assert.equal((await rows('plot_registries')).some(r => r.plot_id === 443), false, 'identity edit does not create financial records');
    await assert.rejects(plotModel.update(439, { status: 'REGISTRY' }, pool), /OLD/);
    assert.equal((await rows('plots')).find(p => p.id === 439).status, 'BOOKED');
    assert.deepEqual(await rows('plot_payments'), sourcePayments, 'registry mappings never create or modify source receipts');
    const plotsBeforeMigration = await rows('plots');

    // Run the real migration twice, including its preservation fingerprint.
    const migration = read('../src/migrations/152_site_project_profiles.js').replace(/^import .*;\n/gm, '').split('up().catch')[0];
    const migrationContext = vm.createContext({ pool, console, process: { exitCode: 0 } });
    vm.runInContext(`${migration}\nthis.migrate = up;`, migrationContext);
    await migrationContext.migrate();
    await migrationContext.migrate();
    assert.equal(migrationContext.process.exitCode, 0);
    const after = (await rows('plots')).map(({ unit_type, unit_details, ...plot }) => {
      assert.equal(unit_type, 'plot');
      assert.deepEqual(unit_details, {});
      return plot;
    });
    assert.deepEqual(after, plotsBeforeMigration);
    await db.query(`UPDATE sites SET project_profile = '{"inventory_type":"mixed"}'::jsonb WHERE id=5`);
    await db.query(`INSERT INTO plots(id,site_id,plot_no,plot_size,status,plot_tag,unit_type) VALUES (440,5,'F1',900,'BOOKED','NEW','flat')`);
    assert.equal((await invoke('createPlotNocRegistry', 440)).status, 201);
    assert.equal(Number((await rows('plot_registries')).find(r => r.plot_id === 440).size_sqyard), 100, 'flat square feet convert to square yards');
    // The database invariant also covers old APIs, imports and new registered
    // records without depending on the JavaScript model being deployed.
    await db.query(`INSERT INTO plots(id,site_id,plot_no,buyer_name,plot_size,plot_size_mtr,circle_rate,status,plot_tag)
      VALUES (444,5,'A43','Legacy Registered',100,83.61,7200,'REGISTRY','NEW'),
             (445,5,'A44','Import Buyer',100,83.61,7200,'BOOKED','NEW'),
             (446,5,'A45','Rollback Buyer',100,83.61,7200,'BOOKED','NEW'),
             (447,5,'A46','Old Buyer',100,83.61,7200,'REGISTRY','OLD')`);
    await db.query(`INSERT INTO plot_payments(id,plot_id,site_id,date,amount,payment_type,status)
      VALUES (8,444,5,'2026-09-01',800,'BANK','approved'),
             (9,445,5,'2026-09-01',900,'BANK','approved'),
             (10,446,5,'2026-09-01',1000,'BANK','approved'),
             (12,445,5,'2026-09-01',300,'CASH','approved')`);
    // Existing databases were unique by number, preventing a current resale
    // booking from getting its own registry while the old history was retained.
    await db.exec('ALTER TABLE plot_registries ADD CONSTRAINT plot_registries_site_id_plot_no_key UNIQUE(site_id, plot_no)');
    await db.query("UPDATE plots SET status = 'RESALE', plot_tag = 'OLD' WHERE id = 438");
    await db.query(`INSERT INTO plots(id,site_id,plot_no,buyer_name,plot_size,plot_size_mtr,circle_rate,status,plot_tag)
      VALUES (449,5,'A38','Resale Buyer',100,83.61,7200,'REGISTRY','NEW')`);
    const paymentsBeforeTrigger = await rows('plot_payments');
    const registriesBeforeTrigger = await rows('plot_registries');
    await db.exec(registeredPlotWorkspaceSql);
    assert.equal((await rows('plot_registries')).find(r => r.plot_id === 444).customer_name, 'LEGACY REGISTERED');
    assert.equal((await rows('plot_registries')).find(r => r.plot_id === 449).customer_name, 'RESALE BUYER');
    assert.equal((await rows('plot_registries')).filter(r => r.plot_no === 'A38').length, 2, 'each resale booking keeps its own registry');
    assert.equal((await rows('plot_registries')).some(r => r.plot_id === 447), false, 'old resale history stays excluded');
    await db.exec(registeredPlotWorkspaceSql); // rerunnable, including backfill
    assert.equal((await rows('plot_registries')).filter(r => r.plot_id === 444).length, 1);
    await db.query("UPDATE plots SET status = ' Registry ' WHERE id = 445");
    const imported = (await rows('plot_registries')).find(r => r.plot_id === 445);
    assert.equal(imported.customer_name, 'IMPORT BUYER');
    assert.equal(imported.noc_generated_at, null);
    assert.equal(imported.noc_approved_at, null);
    await db.query("UPDATE plots SET status = 'REGISTRY' WHERE id = 445");
    assert.equal((await rows('plot_registries')).filter(r => r.plot_id === 445).length, 1);
    assert.equal((await rows('plot_registry_payments')).filter(r => r.source_plot_payment_id === 9).length, 1);
    assert.equal((await rows('plot_registry_payments')).filter(r => r.source_plot_payment_id === 12).length, 0,
      'database trigger does not link cash on an imported status change');
    await db.query(`INSERT INTO plots(id,site_id,plot_no,buyer_name,status,plot_tag)
      VALUES (448,5,'A47','New Registered','REGISTRY','NEW')`);
    assert.equal((await rows('plot_registries')).find(r => r.plot_id === 448).customer_name, 'NEW REGISTERED');
    await db.exec(`CREATE FUNCTION reject_test_mapping() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.source_plot_payment_id = 10 THEN RAISE EXCEPTION 'Test mapping failure'; END IF; RETURN NEW; END; $$;
      CREATE TRIGGER reject_test_mapping BEFORE INSERT ON plot_registry_payments FOR EACH ROW EXECUTE FUNCTION reject_test_mapping();`);
    await assert.rejects(db.query("UPDATE plots SET status = 'REGISTRY' WHERE id = 446"), /Test mapping failure/);
    assert.equal((await rows('plots')).find(p => p.id === 446).status, 'BOOKED');
    assert.equal((await rows('plot_registries')).some(r => r.plot_id === 446), false);
    await db.exec('DROP TRIGGER reject_test_mapping ON plot_registry_payments');
    await plotModel.update(446, { status: 'REGISTRY' }, pool);
    assert.equal((await rows('plot_registries')).filter(r => r.plot_id === 446).length, 1, 'DB trigger and application fallback coexist');

    // Upgrade a database with historic auto-linked cash. A cash receipt
    // explicitly linked later must survive the one-time cleanup.
    await db.query(`INSERT INTO plot_payments(id,plot_id,site_id,date,amount,payment_type,status)
      VALUES (13,438,5,'2026-09-01',150,'CASH','approved')`);
    const originalRegistryId = (await rows('plot_registries')).find(r => r.plot_id === 438).id;
    await db.query(`INSERT INTO plot_registry_payments(registry_id,site_id,source_plot_payment_id,payment_mode,amount,created_at)
      SELECT id, site_id, 1, 'CASH', 1000, created_at FROM plot_registries WHERE id = $1`, [originalRegistryId]);
    await db.query(`INSERT INTO plot_registry_payments(registry_id,site_id,source_plot_payment_id,payment_mode,amount,created_at)
      SELECT id, site_id, 13, 'CASH', 150, created_at + interval '1 second' FROM plot_registries WHERE id = $1`, [originalRegistryId]);
    await db.exec(manualCashLinksSql);
    assert.equal((await rows('plot_registry_payments')).some(r => r.source_plot_payment_id === 1), false,
      'historic automatic cash link is removed');
    assert.equal((await rows('plot_registry_payments')).some(r => r.source_plot_payment_id === 13), true,
      'manually linked cash is preserved');
    assert.deepEqual((await rows('plot_payments')).filter(row => row.id !== 13), paymentsBeforeTrigger);
    assert.deepEqual((await rows('plot_registries')).filter(r => registriesBeforeTrigger.some(old => old.id === r.id)), registriesBeforeTrigger,
      'migration preserves existing registry and NOC data');
  } finally { await db.close(); }
});
