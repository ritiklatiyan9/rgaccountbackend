import assert from 'node:assert/strict';
import test from 'node:test';
import { migrationSql as originalApprovalSql } from '../src/migrations/158_plot_status_approval.js';
import { migrationSql as statusSettingSql, up as applyStatusSetting } from '../src/migrations/177_plot_status_approval_setting.js';
import { VERSION as directStatusVersion, migrationSql as directStatusSql } from '../src/migrations/258_direct_plot_status.js';
import { VERSION as finalizeVersion, up as finalizePendingBookings } from '../src/migrations/259_finalize_pending_bookings.js';
import { isDirectPlotBooking, isDirectPlotStatusChange } from '../src/services/plotApproval.service.js';
import { plotModel } from '../src/models/Plot.model.js';

test('a status change or booking is direct and mixed property edits still require review', () => {
  assert.equal(isDirectPlotStatusChange({ status: 'BOOKED' }, 'COMPANY'), true);
  assert.equal(isDirectPlotStatusChange({ status: 'BOOKED', booking_date: '2026-11-26', assigned_admin_id: 2 }, 'COMPANY'), true);
  assert.equal(isDirectPlotStatusChange({ status: 'BOOKED', booking_date: '2026-11-26' }, 'BOOKED'), false);
  assert.equal(isDirectPlotStatusChange({ status: 'BOOKED', notes: 'changed' }, 'COMPANY'), false);
  const booking = { status: 'BOOKED', buyer_name: 'Customer', booking_installment_settings: { installments_enabled: true } };
  assert.equal(isDirectPlotBooking(booking, { status: 'COMPANY' }), true);
  assert.equal(isDirectPlotBooking(booking, { status: 'BOOKED', buyer_name: '' }), true);
  assert.equal(isDirectPlotBooking(booking, { status: 'BOOKED', buyer_name: 'Another customer' }), false);
  assert.equal(isDirectPlotBooking({ ...booking, plot_no: 'A12' }, { status: 'COMPANY' }), false);
});

test('status setting trigger is reapplied after the original startup migration', async () => {
  const statements = [];
  const client = {
    query: async (sql) => { statements.push(sql); return { rows: [] }; },
    release: () => {},
  };
  await applyStatusSetting({ connect: async () => client });
  assert.ok(statements.includes(statusSettingSql));
  assert.ok(statements.some((sql) => sql.includes("INSERT INTO app_schema_migrations") && sql.includes('ON CONFLICT DO NOTHING')));
  assert.equal(statements.at(-1), 'COMMIT');
});

test('a later startup does not reinstall the legacy site status setting', async () => {
  const statements = [];
  const client = {
    query: async sql => { statements.push(sql); return { rows: sql.includes('258_direct_plot_status') ? [{ '?column?': 1 }] : [] }; },
    release: () => {},
  };
  await applyStatusSetting({ connect: async () => client });
  assert.ok(!statements.includes(statusSettingSql));
  assert.equal(statements.at(-1), 'COMMIT');
});

// Supply PGLITE_MODULE to run the trigger against isolated PostgreSQL.
test('status, new bookings and booking terms save without adding a review', { skip: !process.env.PGLITE_MODULE }, async () => {
  const { PGlite } = await import(process.env.PGLITE_MODULE);
  const db = new PGlite();
  try {
    await db.exec(`
      CREATE TABLE users(id integer PRIMARY KEY);
      CREATE TABLE sites(id integer PRIMARY KEY, organization_id integer DEFAULT 1);
      CREATE TABLE app_schema_migrations(version text PRIMARY KEY);
      INSERT INTO users VALUES (1), (2);
      INSERT INTO sites(id) VALUES (1), (2);
      CREATE TABLE plots(id serial PRIMARY KEY, site_id integer, plot_no text,
        buyer_name text, buyer_member_id integer, status text, notes text, assigned_admin_id integer,
        booking_date date, co_applicants jsonb, installments_enabled boolean, interest_rate numeric,
        booking_cancelled_at timestamptz, booking_settlement_commission numeric,
        created_by integer, plot_tag text, updated_at timestamptz DEFAULT now());
      CREATE TABLE application_settings(site_id integer, setting_key text,
        setting_value jsonb, UNIQUE(site_id, setting_key));
      CREATE TABLE audit_logs(id serial PRIMARY KEY, organization_id integer, site_id integer, action text,
        event_type text, module text, entity_type text, entity_id text, outcome text, description text,
        old_values jsonb, new_values jsonb, metadata jsonb);
    `);
    await db.exec(originalApprovalSql);
    await db.exec(statusSettingSql);
    await db.exec(directStatusSql);
    const row = async (id = 1) => (await db.query('SELECT * FROM plots WHERE id=$1', [id])).rows[0];

    await db.exec("INSERT INTO plots(site_id, plot_no, status, assigned_admin_id, created_by) VALUES (1, 'A1', 'COMPANY', 1, 1)");
    assert.equal((await row()).approval_status, 'pending', 'new inventory is reviewed');

    await db.exec("UPDATE plots SET approval_status = 'approved', approved_by = 1 WHERE id = 1");
    const previousRequest = (await row()).approval_requested_at;
    await db.exec("INSERT INTO application_settings VALUES (1, 'plot_status_approval_required', 'true'::jsonb)");
    await db.exec("UPDATE plots SET status = 'AVAILABLE', booking_date = '2026-11-26', assigned_admin_id = 2, approval_requested_at = now() WHERE id = 1");
    assert.equal((await row()).status, 'AVAILABLE');
    assert.equal((await row()).approval_status, 'approved');
    assert.equal((await row()).assigned_admin_id, 1);
    assert.deepEqual((await row()).approval_requested_at, previousRequest);

    const preview = await row();
    const database = { connect: async () => ({ query: db.query.bind(db), release() {} }) };
    const booking = { status: 'BOOKED', buyer_name: 'Customer', buyer_member_id: 1,
      installments_enabled: true, interest_rate: 12, co_applicants: '[]' };
    await plotModel.update(1, booking, database, { expectedPlot: preview, directBooking: true });
    assert.equal((await row()).status, 'BOOKED');
    assert.equal((await row()).approval_status, 'approved');
    assert.deepEqual((await row()).approval_requested_at, previousRequest);
    assert.equal((await row()).installments_enabled, true);
    assert.equal(await plotModel.update(1, booking, database, { expectedPlot: preview, directBooking: true }), null,
      'a stale booking cannot replace the current buyer');

    await db.exec("INSERT INTO plots(site_id, plot_no, status, buyer_name, created_by) VALUES (2, 'B1', 'BOOKED', 'New buyer', 1)");
    assert.equal((await row(2)).approval_status, 'approved');
    assert.equal((await row(2)).approval_requested_at, null);

    await db.exec("UPDATE plots SET notes = 'revised', approval_requested_at = now() WHERE id = 1");
    assert.equal((await row()).approval_status, 'pending', 'other plot edits still queue');
    const detailRequest = (await row()).approval_requested_at;
    await db.exec("UPDATE plots SET status = 'COMPANY', approval_requested_at = now() WHERE id = 1");
    assert.equal((await row()).approval_status, 'pending', 'an existing review remains pending');
    assert.deepEqual((await row()).approval_requested_at, detailRequest, 'status did not send another request');

    await db.exec("UPDATE plots SET status = 'CANCELLED', booking_cancelled_at = now(), booking_settlement_commission = 100 WHERE id = 2");
    assert.equal((await row(2)).approval_status, 'pending', 'cancellation settlements keep their review');

    await db.exec("INSERT INTO plots(site_id, plot_no, status, created_by) VALUES (2, 'B2', 'COMPANY', 1)");
    await db.exec("UPDATE plots SET approval_status = 'approved' WHERE id = 3");
    await db.exec("UPDATE plots SET status = 'BOOKED', buyer_name = 'Allotted customer', assigned_admin_id = 2 WHERE id = 3");
    assert.equal((await row(3)).approval_status, 'pending', 'allotment can still request its own review');

    await assert.rejects(finalizePendingBookings(database), /Deploy direct plot status updates first/);
    await db.query('INSERT INTO app_schema_migrations VALUES ($1)', [directStatusVersion]);
    assert.deepEqual(await finalizePendingBookings(database), { finalized: 1, alreadyApplied: false });
    assert.deepEqual(await finalizePendingBookings(database), { finalized: 0, alreadyApplied: true });
    assert.equal((await row(1)).approval_status, 'pending', 'separate details review is preserved');
    assert.equal((await row(2)).approval_status, 'pending', 'cancellation settlement is preserved');
    assert.equal((await row(3)).status, 'BOOKED');
    assert.equal((await row(3)).approval_status, 'approved');
    const { rows: [audit] } = await db.query('SELECT site_id, entity_id, new_values FROM audit_logs WHERE metadata->>\'migration\'=$1', [finalizeVersion]);
    assert.deepEqual(audit, { site_id: 2, entity_id: '3', new_values: { status: 'BOOKED', approval_status: 'approved' } });
  } finally {
    await db.close();
  }
});
