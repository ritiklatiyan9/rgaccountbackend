import test from 'node:test';
import assert from 'node:assert/strict';
import { migrationSql as previousSyncSql } from '../src/migrations/181_plot_registry_circle_rate_sync.js';
import { migrationSql as roundingSql, up } from '../src/migrations/206_plot_bank_target_rounding.js';
import { migrationSql as approvalSql } from '../src/migrations/158_plot_status_approval.js';
import { migrationSql as areaSql } from '../src/migrations/205_plot_area_conversion_and_approval_changes.js';

test('plot bank ceiling survives old circle-rate sync and keeps registry amounts aligned', async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  const db = new PGlite();
  try {
    await db.exec(`
      CREATE TABLE app_schema_migrations(version text PRIMARY KEY);
      CREATE TABLE plots(id int PRIMARY KEY, site_id int, plot_size numeric,
        plot_size_mtr numeric, unit_type text, circle_rate numeric,
        to_receive_bank numeric, updated_at timestamptz, notes text);
      CREATE TABLE plot_registries(id int PRIMARY KEY, site_id int, plot_id int,
        circle_rate numeric, bank_amount numeric, registry_payment numeric, updated_at timestamptz);
      INSERT INTO plots VALUES(1,5,205.51,171.8886,'plot',7200,1237597.92,NOW(),'');
      INSERT INTO plot_registries VALUES(1,5,1,7200,1237597.92,1237597.92,NOW());
    `);
    await db.exec(previousSyncSql);
    const database = { connect: async () => ({
      query: async (sql, values) => sql === roundingSql ? (await db.exec(sql), { rows: [] }) : db.query(sql, values),
      release() {},
    }) };
    assert.equal(await up(database), true);
    assert.equal(await up(database), false, 'migration is safe to rerun');
    assert.equal(Number((await db.query('SELECT to_receive_bank FROM plots WHERE id=1')).rows[0].to_receive_bank), 1237597.92, 'install does not rewrite historic targets');
    await db.exec("UPDATE plots SET notes='Metadata only' WHERE id=1");
    assert.equal(Number((await db.query('SELECT to_receive_bank FROM plots WHERE id=1')).rows[0].to_receive_bank), 1237597.92);

    const assertTarget = async (expected) => {
      const plot = (await db.query('SELECT * FROM plots WHERE id=1')).rows[0];
      const registry = (await db.query('SELECT * FROM plot_registries WHERE id=1')).rows[0];
      assert.equal(Number(plot.to_receive_bank), expected);
      assert.equal(Number(registry.bank_amount), expected);
      assert.equal(Number(registry.registry_payment), expected);
      assert.equal(Number(registry.circle_rate), Number(plot.circle_rate));
    };
    const saved = await db.query('UPDATE plots SET circle_rate=7200, to_receive_bank=1237597.92 WHERE id=1 RETURNING to_receive_bank');
    assert.equal(Number(saved.rows[0].to_receive_bank), 1238000, 'API receives the rounded saved amount');
    await assertTarget(1238000);
    await db.exec('UPDATE plots SET circle_rate=8000 WHERE id=1');
    await assertTarget(1376000);
    await db.exec('UPDATE plots SET plot_size_mtr=100, circle_rate=7000 WHERE id=1');
    await assertTarget(700000);
    await db.exec('UPDATE plots SET plot_size_mtr=100.0001 WHERE id=1');
    await assertTarget(701000);
    await db.exec('UPDATE plot_registries SET circle_rate=7200 WHERE id=1');
    await assertTarget(721000);
    await db.exec('UPDATE plots SET circle_rate=0 WHERE id=1');
    await assertTarget(0);
    await db.exec(`INSERT INTO plots VALUES(2,8,130.56,NULL,'plot',7000,1,NOW(),''),
      (3,10,900,83.6127,'flat',7000,1,NOW(),'');`);
    assert.deepEqual((await db.query('SELECT to_receive_bank FROM plots WHERE id IN (2,3) ORDER BY id')).rows.map(r => Number(r.to_receive_bank)), [765000,586000]);
  } finally { await db.close(); }
});

test('area normalization and approval snapshots use the same rounded bank target', async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  const db = new PGlite();
  try {
    await db.exec(`
      CREATE TABLE users(id int PRIMARY KEY);
      INSERT INTO users VALUES(1);
      CREATE TABLE app_schema_migrations(version text PRIMARY KEY);
      CREATE TABLE application_settings(site_id int, setting_key text, setting_value jsonb);
      CREATE TABLE plots(id int PRIMARY KEY, site_id int, plot_no text, buyer_name text,
        plot_size numeric(14,4), plot_size_mtr numeric(14,4), unit_type text,
        status text, plot_tag text, assigned_admin_id int, created_by int,
        updated_at timestamptz, sale_price numeric, circle_rate numeric, to_receive_bank numeric);
      CREATE TABLE plot_registries(id int PRIMARY KEY, site_id int, plot_id int,
        size_sqyard numeric(14,4), size_meter numeric(14,4), circle_rate numeric,
        bank_amount numeric, registry_payment numeric, updated_at timestamptz);
    `);
    await db.exec(approvalSql);
    await db.exec(`INSERT INTO plots(id,site_id,plot_no,plot_size,plot_size_mtr,unit_type,status,created_by,circle_rate,to_receive_bank)
      VALUES(1,5,'A1',205.51,171.89,'plot','REGISTRY',1,7200,1237608);
      UPDATE plots SET approval_status='approved';
      INSERT INTO plot_registries VALUES(1,5,1,205.51,171.89,7200,1237608,1237608,NOW());`);
    await db.exec(areaSql);
    await db.exec(previousSyncSql);
    await db.exec(roundingSql);
    await db.exec('UPDATE plots SET plot_size=100 WHERE id=1');
    const plot = (await db.query('SELECT * FROM plots WHERE id=1')).rows[0];
    const registry = (await db.query('SELECT * FROM plot_registries WHERE id=1')).rows[0];
    assert.equal(Number(plot.plot_size_mtr), 83.64);
    assert.equal(Number(plot.to_receive_bank), 603000);
    assert.equal(plot.approval_status, 'pending');
    assert.equal(Number(plot.approval_original_data.to_receive_bank), 1237608);
    assert.equal(Number(plot.approval_proposed_data.to_receive_bank), 603000);
    assert.equal(Number(registry.size_meter), 83.64);
    assert.equal(Number(registry.bank_amount), 603000);
    assert.equal(Number(registry.registry_payment), 603000);
  } finally { await db.close(); }
});
