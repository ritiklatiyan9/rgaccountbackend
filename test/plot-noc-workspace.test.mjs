import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');

// In-memory PostgreSQL only. No application credentials or real NOC records.
test('NOC drafts work before and after migration 152 without changing payments or plot status', { skip: !process.env.PGLITE_MODULE }, async () => {
  const { PGlite } = await import(process.env.PGLITE_MODULE);
  const db = new PGlite();
  try {
    await db.exec(`
      CREATE TABLE app_schema_migrations(version text PRIMARY KEY);
      CREATE TABLE sites(id integer PRIMARY KEY, name text);
      CREATE TABLE plots(id integer PRIMARY KEY, site_id integer, plot_no text, buyer_name text,
        plot_size numeric, plot_size_mtr numeric, circle_rate numeric, to_receive_bank numeric,
        assigned_admin_id integer, status text, plot_tag text);
      CREATE TABLE plot_payments(id integer PRIMARY KEY, plot_id integer, site_id integer, date date,
        amount numeric, payment_type text, payment_from text, bank_details text, narration text,
        cheque_no text, cheque_status text, status text, approved_by integer, approved_at timestamptz,
        created_at timestamptz DEFAULT now());
      CREATE TABLE plot_registries(id serial PRIMARY KEY, site_id integer, plot_id integer UNIQUE,
        plot_no text, customer_name text, size_meter numeric, size_sqyard numeric, circle_rate numeric,
        created_entry_date date, bank_amount numeric, registry_payment numeric, notes text,
        assigned_admin_id integer, created_by integer, noc_generated_at timestamptz,
        noc_approved_at timestamptz, updated_at timestamptz DEFAULT now());
      CREATE TABLE plot_registry_payments(id serial PRIMARY KEY, registry_id integer, site_id integer,
        payment_date date, amount numeric, payment_mode text, tally_date date, tally_amount numeric,
        notes text, source_plot_payment_id integer UNIQUE, include_in_noc boolean, cheque_no text,
        cheque_status text, status text, approved_by integer, approved_at timestamptz, created_by integer);
      INSERT INTO sites VALUES (5, 'Test project');
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
    const ctx = vm.createContext({ pool, asyncHandler: fn => fn, console });
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
    assert.equal(Number(created.body.registry.registry_payment), 1200);
    assert.equal(Number((await rows('plot_registries'))[0].size_sqyard), 100, 'legacy schema defaults to plots');
    assert.deepEqual((await rows('plot_registry_payments')).map(p => p.source_plot_payment_id), [1, 2]);
    const repeat = await invoke('createPlotNocRegistry');
    assert.equal(repeat.body.created, false);
    assert.equal(repeat.body.registry.id, created.body.registry.id);
    assert.equal((await rows('plot_registries')).length, 1);
    assert.equal((await invoke('getPlotNocRegistry')).body.registry.id, created.body.registry.id);
    assert.deepEqual({ plots: await rows('plots'), payments: await rows('plot_payments') }, before);

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
    assert.deepEqual(after, before.plots);
    await db.query(`UPDATE sites SET project_profile = '{"inventory_type":"mixed"}'::jsonb WHERE id=5`);
    await db.query(`INSERT INTO plots(id,site_id,plot_no,plot_size,status,plot_tag,unit_type) VALUES (440,5,'F1',900,'BOOKED','NEW','flat')`);
    assert.equal((await invoke('createPlotNocRegistry', 440)).status, 201);
    assert.equal(Number((await rows('plot_registries')).find(r => r.plot_id === 440).size_sqyard), 100, 'flat square feet convert to square yards');
  } finally { await db.close(); }
});
