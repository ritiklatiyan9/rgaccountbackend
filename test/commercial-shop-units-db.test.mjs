import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { migrationSql, up } from '../src/migrations/239_commercial_shop_units.js';
import { migrationSql as bankTargetSql } from '../src/migrations/206_plot_bank_target_rounding.js';

test('shop migration preserves records, enforces profiles and keeps commercial registry conversions correct', async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      CREATE TABLE app_schema_migrations(version text PRIMARY KEY);
      CREATE TABLE sites(id int PRIMARY KEY, project_profile jsonb NOT NULL);
      CREATE TABLE plots(id int PRIMARY KEY, site_id int REFERENCES sites(id),
        unit_type text NOT NULL DEFAULT 'plot' CHECK(unit_type IN ('plot','flat')),
        plot_size numeric, plot_size_mtr numeric, circle_rate numeric,
        to_receive_bank numeric, updated_at timestamptz);
      CREATE TABLE plot_registries(id int PRIMARY KEY, site_id int, plot_id int,
        size_sqyard numeric, size_meter numeric, circle_rate numeric,
        bank_amount numeric, registry_payment numeric, updated_at timestamptz);
      INSERT INTO sites VALUES(1,'{"inventory_type":"plots"}'),(2,'{"inventory_type":"mixed"}');
      INSERT INTO plots VALUES(1,1,'plot',100,84,7200,604800,'2026-01-01'),
        (2,2,'flat',900,83.6127,7200,602011.44,'2026-01-01');
      INSERT INTO plot_registries VALUES(1,1,1,100,84,7200,604800,604800,'2026-01-01');
    `);
    await db.exec(bankTargetSql);
    const before = (await db.query('SELECT * FROM plots ORDER BY id')).rows;
    const sitesBefore = (await db.query('SELECT * FROM sites ORDER BY id')).rows;
    const registriesBefore = (await db.query('SELECT * FROM plot_registries ORDER BY id')).rows;
    const database = { connect: async () => ({
      query: async (sql, values) => sql === migrationSql ? (await db.exec(sql), { rows: [] }) : db.query(sql, values),
      release() {},
    }) };
    assert.equal(await up(database), true);
    assert.equal(await up(database), false);
    assert.deepEqual((await db.query('SELECT * FROM plots ORDER BY id')).rows, before);
    assert.deepEqual((await db.query('SELECT * FROM sites ORDER BY id')).rows, sitesBefore);
    assert.deepEqual((await db.query('SELECT * FROM plot_registries ORDER BY id')).rows, registriesBefore);

    // These triggers already exist in the main application (migrations 176/205).
    await db.exec(`CREATE TRIGGER plots_00_normalize_area BEFORE INSERT OR UPDATE OF plot_size,plot_size_mtr,unit_type ON plots FOR EACH ROW EXECUTE FUNCTION normalize_plot_square_metres();
      CREATE TRIGGER trg_sync_registry_area_from_plot AFTER UPDATE OF plot_size,plot_size_mtr,unit_type ON plots FOR EACH ROW EXECUTE FUNCTION sync_registry_area_from_plot();
      CREATE TRIGGER trg_registry_20_normalize_area BEFORE INSERT OR UPDATE OF size_meter,size_sqyard,plot_id ON plot_registries FOR EACH ROW EXECUTE FUNCTION normalize_registry_square_metres();
      INSERT INTO sites VALUES(3,'{"inventory_type":"shops"}'),(4,'{"inventory_type":"plots_shops"}');`);
    await assert.rejects(db.exec("INSERT INTO plots(id,site_id,unit_type) VALUES(3,1,'shop')"), /not enabled/);
    await assert.rejects(db.exec("INSERT INTO plots(id,site_id,unit_type) VALUES(3,2,'shop')"), /not enabled/);
    await assert.rejects(db.exec("INSERT INTO plots(id,site_id,unit_type) VALUES(3,3,'plot')"), /not enabled/);
    await assert.rejects(db.exec("INSERT INTO sites VALUES(5,'{\"inventory_type\":\"invalid\"}')"), /Invalid project/);
    await db.exec("INSERT INTO plots(id,site_id,unit_type,plot_size,circle_rate) VALUES(3,3,'shop',900,7200)");
    let shop = (await db.query('SELECT * FROM plots WHERE id=3')).rows[0];
    assert.equal(Number(shop.plot_size_mtr), 83.6127);
    assert.equal(Number(shop.to_receive_bank), 603000);
    await db.exec('INSERT INTO plot_registries(id,site_id,plot_id,size_sqyard) VALUES(3,3,3,900)');
    assert.equal(Number((await db.query('SELECT size_sqyard FROM plot_registries WHERE id=3')).rows[0].size_sqyard), 100, 'legacy automatic workspace writes also use square yards');
    await db.exec('UPDATE plots SET plot_size=1800 WHERE id=3');
    shop = (await db.query('SELECT * FROM plots WHERE id=3')).rows[0];
    const registry = (await db.query('SELECT * FROM plot_registries WHERE id=3')).rows[0];
    assert.equal(Number(shop.plot_size_mtr), 167.2255);
    assert.equal(Number(registry.size_sqyard), 200);
    assert.equal(Number(registry.size_meter), 167.2255);
    assert.equal(Number(registry.bank_amount), Number(shop.to_receive_bank));
    await assert.rejects(db.exec("UPDATE sites SET project_profile='{\"inventory_type\":\"plots\"}' WHERE id=3"), /every existing unit type/);
    await assert.rejects(db.exec("UPDATE plots SET unit_type='flat' WHERE id=3"), /cannot change/);
    await assert.rejects(db.exec('UPDATE plots SET site_id=1 WHERE id=3'), /not enabled/);
    await db.exec("UPDATE sites SET project_profile='{\"inventory_type\":\"plots_shops\"}' WHERE id=1");
    await db.exec("INSERT INTO plots(id,site_id,unit_type,plot_size) VALUES(4,1,'shop',300)");
    assert.equal((await db.query('SELECT unit_type FROM plots WHERE id=1')).rows[0].unit_type, 'plot');
  } finally { await db.close(); }
});
