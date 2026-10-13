import test from 'node:test';
import assert from 'node:assert/strict';
import { migrationSql as approvalSql } from '../src/migrations/158_plot_status_approval.js';
import { migrationSql as areaSql } from '../src/migrations/205_plot_area_conversion_and_approval_changes.js';

test('area edits normalize across sites, sync registries and capture the approval diff', async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  const db = new PGlite();
  try {
    await db.exec(`
      CREATE TABLE users(id int PRIMARY KEY);
      INSERT INTO users VALUES(1);
      CREATE TABLE app_schema_migrations(version text PRIMARY KEY);
      CREATE TABLE application_settings(site_id int, setting_key text, setting_value jsonb);
      CREATE TABLE plots(id int PRIMARY KEY, site_id int, plot_no text, buyer_name text,
        plot_size numeric(10,2), plot_size_mtr numeric(10,2), unit_type text,
        status text, plot_tag text, assigned_admin_id int, created_by int,
        updated_at timestamptz, sale_price numeric, to_receive_bank numeric);
      CREATE TABLE plot_registries(id int PRIMARY KEY, site_id int, plot_id int,
        size_sqyard numeric(10,2), size_meter numeric(10,2), registry_payment numeric);
    `);
    await db.exec(approvalSql);
    await db.exec(`INSERT INTO plots(id,site_id,plot_no,plot_size,plot_size_mtr,unit_type,status,created_by,sale_price,to_receive_bank)
      VALUES (1,5,'B47',235,196.49,'plot','REGISTRY',1,500000,100000),
        (2,8,'A1',130.56,109.16,'plot','BOOKED',1,600000,200000),
        (3,10,'F1',900,83.61,'flat','BOOKED',1,700000,300000);
      UPDATE plots SET approval_status='approved';
      INSERT INTO plot_registries VALUES(1,5,1,235,196.49,100000);
    `);
    await db.exec(areaSql);
    await db.exec('UPDATE plots SET plot_size_mtr=0 WHERE id IN (1,2)');
    const { rows } = await db.query('SELECT * FROM plots ORDER BY id');
    assert.equal(Number(rows[0].plot_size_mtr), 196.554);
    assert.equal(Number(rows[1].plot_size_mtr), 109.2004);
    assert.equal(Number(rows[2].plot_size_mtr), 83.61, 'flat is untouched');
    assert.equal(Number(rows[0].sale_price), 500000);
    assert.equal(Number(rows[0].to_receive_bank), 100000);
    assert.equal(rows[0].approval_status, 'pending');
    assert.equal(Number(rows[0].approval_original_data.plot_size_mtr), 196.49);
    assert.equal(Number(rows[0].approval_proposed_data.plot_size_mtr), 196.554);
    assert.equal(Number((await db.query('SELECT size_meter FROM plot_registries WHERE id=1')).rows[0].size_meter), 196.554);
    assert.ok((await db.query('SELECT approval_original_data FROM plot_status_approvals WHERE id=1')).rows[0].approval_original_data);
    await db.exec('UPDATE plots SET plot_size=236 WHERE id=1');
    const pending = (await db.query('SELECT * FROM plots WHERE id=1')).rows[0];
    assert.equal(Number(pending.approval_original_data.plot_size_mtr), 196.49, 'first pending original survives');
    assert.equal(Number(pending.approval_proposed_data.plot_size_mtr), 197.3904);
    await db.exec('UPDATE plot_registries SET size_meter=1 WHERE id=1');
    assert.equal(Number((await db.query('SELECT size_meter FROM plot_registries WHERE id=1')).rows[0].size_meter), 197.3904);
    await db.exec("INSERT INTO plots(id,site_id,plot_no,plot_size,plot_size_mtr,unit_type,status,created_by) VALUES(4,2,'C1',83.11,1,'plot','BOOKED',1)");
    assert.equal(Number((await db.query('SELECT plot_size_mtr FROM plots WHERE id=4')).rows[0].plot_size_mtr), 69.5132);
    await db.exec('INSERT INTO plot_registries VALUES(2,2,NULL,83.11,1,500)');
    assert.equal(Number((await db.query('SELECT size_meter FROM plot_registries WHERE id=2')).rows[0].size_meter), 69.5132);
    // Older startup migrations must keep the snapshot-bearing view valid.
    await db.exec(approvalSql);
    assert.ok((await db.query('SELECT approval_original_data FROM plot_status_approvals WHERE id=1')).rows[0].approval_original_data);
  } finally { await db.close(); }
});
