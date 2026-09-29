import assert from 'node:assert/strict';
import test from 'node:test';
import pool from '../src/config/db.js';
import applicationSettingModel, { FEATURE_KEYS } from '../src/models/ApplicationSetting.model.js';
import { migrationSql as originalApprovalSql } from '../src/migrations/158_plot_status_approval.js';
import { migrationSql as statusSettingSql } from '../src/migrations/177_plot_status_approval_setting.js';

test('plot status approval defaults on and reads a site override', async () => {
  const query = pool.query;
  pool.query = async (_sql, params) => ({
    rows: Number(params[0]) === 2
      ? [{ setting_key: FEATURE_KEYS.PLOT_STATUS_APPROVAL_REQUIRED, setting_value: false }]
      : [],
  });
  try {
    assert.equal(await applicationSettingModel.isFeatureEnabled(1, FEATURE_KEYS.PLOT_STATUS_APPROVAL_REQUIRED), true);
    assert.equal(await applicationSettingModel.isFeatureEnabled(2, FEATURE_KEYS.PLOT_STATUS_APPROVAL_REQUIRED), false);
    assert.equal((await applicationSettingModel.getFeatures(1))[FEATURE_KEYS.PLOT_STATUS_APPROVAL_REQUIRED], true);
    assert.equal((await applicationSettingModel.getFeatures(2))[FEATURE_KEYS.PLOT_STATUS_APPROVAL_REQUIRED], false);
  } finally {
    pool.query = query;
  }
});

// Supply PGLITE_MODULE to run the trigger against isolated PostgreSQL.
test('status approval switch preserves other plot reviews', { skip: !process.env.PGLITE_MODULE }, async () => {
  const { PGlite } = await import(process.env.PGLITE_MODULE);
  const db = new PGlite();
  try {
    await db.exec(`
      CREATE TABLE users(id integer PRIMARY KEY);
      CREATE TABLE sites(id integer PRIMARY KEY);
      CREATE TABLE app_schema_migrations(version text PRIMARY KEY);
      INSERT INTO users VALUES (1);
      INSERT INTO sites VALUES (1), (2);
      CREATE TABLE plots(id serial PRIMARY KEY, site_id integer, plot_no text,
        buyer_name text, status text, notes text, assigned_admin_id integer,
        created_by integer, plot_tag text, updated_at timestamptz DEFAULT now());
      CREATE TABLE application_settings(site_id integer, setting_key text,
        setting_value jsonb, UNIQUE(site_id, setting_key));
    `);
    await db.exec(originalApprovalSql);
    await db.exec('ALTER TABLE plots ADD COLUMN approval_original_data jsonb, ADD COLUMN approval_proposed_data jsonb');
    await db.exec(statusSettingSql);
    const row = async () => (await db.query('SELECT status, approval_status, approval_requested_at FROM plots WHERE id = 1')).rows[0];

    await db.exec("INSERT INTO plots(site_id, plot_no, status, assigned_admin_id, created_by) VALUES (1, 'A1', 'COMPANY', 1, 1)");
    assert.equal((await row()).approval_status, 'pending', 'new plots still need review');
    await db.exec("UPDATE plots SET approval_status = 'approved', approved_by = 1 WHERE id = 1");
    await db.exec("UPDATE plots SET status = 'BOOKED', approval_requested_by = 1, approval_requested_at = now() WHERE id = 1");
    assert.equal((await row()).approval_status, 'pending', 'default-on status edit queues');

    await db.exec("UPDATE plots SET approval_status = 'approved', approved_by = 1 WHERE id = 1");
    const previousRequest = (await row()).approval_requested_at;
    await db.exec("INSERT INTO application_settings VALUES (1, 'plot_status_approval_required', 'false'::jsonb)");
    await db.exec("UPDATE plots SET status = 'RESALE', approval_requested_by = 1, approval_requested_at = now() WHERE id = 1");
    assert.equal((await row()).approval_status, 'approved', 'off saves a status-only edit directly');
    assert.deepEqual((await row()).approval_requested_at, previousRequest, 'off does not create a new request');
    await db.exec("INSERT INTO plots(site_id, plot_no, status, assigned_admin_id, created_by) VALUES (2, 'B1', 'COMPANY', 1, 1)");
    await db.exec("UPDATE plots SET approval_status = 'approved', approved_by = 1 WHERE id = 2");
    await db.exec("UPDATE plots SET status = 'BOOKED' WHERE id = 2");
    assert.equal((await db.query('SELECT approval_status FROM plots WHERE id = 2')).rows[0].approval_status,
      'pending', 'another site still queues status edits');

    await db.exec("UPDATE plots SET notes = 'revised', approval_requested_at = now() WHERE id = 1");
    assert.equal((await row()).approval_status, 'pending', 'other plot edits still queue');
    await db.exec("UPDATE plots SET status = 'COMPANY', approval_requested_at = now() WHERE id = 1");
    assert.equal((await row()).approval_status, 'pending', 'an existing review remains pending');

    await db.exec("UPDATE application_settings SET setting_value = 'true'::jsonb WHERE site_id = 1");
    await db.exec("UPDATE plots SET approval_status = 'approved', approved_by = 1 WHERE id = 1");
    await db.exec("UPDATE plots SET status = 'BOOKED' WHERE id = 1");
    assert.equal((await row()).approval_status, 'pending', 'turning on resumes review');
  } finally {
    await db.close();
  }
});
