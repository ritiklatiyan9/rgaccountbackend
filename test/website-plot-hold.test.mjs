import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { PGlite } from '@electric-sql/pglite';
import { withCompanyPlotBooking, completeDeferredChequeBooking } from '../src/services/quickPlotBooking.service.js';
import { plotModel } from '../src/models/Plot.model.js';

// Isolated PostgreSQL engine only; never changes live customers or payments.
async function fixture({ websiteTable = true } = {}) {
  const engine = new PGlite();
  await engine.exec(`CREATE TABLE plots(id integer PRIMARY KEY,site_id integer,plot_no text,status text,buyer_name text,
    buyer_member_id integer,booking_date date,assigned_admin_id integer,approval_requested_by integer,created_by integer,updated_at timestamptz);
    CREATE TABLE members(id integer PRIMARY KEY,site_id integer,status text,full_name text);
    CREATE TABLE users(id integer PRIMARY KEY,is_active boolean,role text);
    CREATE TABLE user_sites(user_id integer,site_id integer);
    CREATE TABLE plot_payments(id integer PRIMARY KEY,plot_id integer,amount numeric,pending_booking_member_id integer,buyer_name text,assigned_admin_id integer);
    CREATE TABLE plot_registries(id integer PRIMARY KEY,plot_id integer,site_id integer,plot_no text,noc_generated_at timestamptz,
      noc_approved_at timestamptz,noc_approved_by integer,registry_payment numeric,updated_at timestamptz);
    INSERT INTO plots VALUES(12,5,'A01','COMPANY','COMPANY',NULL,NULL,7,NULL,1,now()),(13,6,'A01','COMPANY','COMPANY',NULL,NULL,7,NULL,1,now());
    INSERT INTO members VALUES(8,5,'ACTIVE','Buyer'); INSERT INTO users VALUES(7,true,'admin');`);
  if (websiteTable) await engine.exec(`CREATE TABLE website_booking_requests(id serial PRIMARY KEY,plot_id integer,status text,hold_expires_at timestamptz);
    INSERT INTO website_booking_requests(plot_id,status,hold_expires_at) VALUES(12,'AWAITING_PAYMENT',now()+interval '15 minutes');`);
  const calls = [];
  const query = async (sql, params) => { calls.push({ sql, params }); return engine.query(sql, params); };
  const client = { query, release() {} }, pool = { query, connect: async () => client };
  const options = { pool, plotId:12, memberId:8, date:'2026-10-12',
    savePayment: db => db.query('INSERT INTO plot_payments(id,plot_id,amount) VALUES(24,12,1000) RETURNING *') };
  const state = async () => ({ plot:(await engine.query('SELECT * FROM plots WHERE id=12')).rows[0], payments:(await engine.query('SELECT * FROM plot_payments')).rows });
  const websiteState = async () => (await engine.query('SELECT * FROM website_booking_requests')).rows;
  return { engine, pool, client, calls, options, state, websiteState, close: () => engine.close() };
}

function assertWebsiteNotQueried(calls) {
  assert.equal(calls.some(({ sql }) => /website_booking|to_regclass/i.test(sql)), false);
}

test('Accounts booking and payment work independently of unpaid and paid website requests', async () => {
  const f = await fixture();
  try {
    for (const status of ['ORDER_CREATING', 'AWAITING_PAYMENT', 'PAYMENT_REVIEW', 'APPROVED']) {
      await f.engine.query('UPDATE website_booking_requests SET status=$1', [status]);
      const website = await f.websiteState();
      const { bookedPlot } = await withCompanyPlotBooking(f.options);
      assert.equal(bookedPlot.status, 'BOOKED');
      assert.equal(bookedPlot.buyer_member_id, 8);
      assert.equal((await f.state()).payments.length, 1);
      assert.equal(f.calls.at(-1).sql, 'COMMIT');
      assert.deepEqual(await f.websiteState(), website);
      await f.engine.exec("DELETE FROM plot_payments; UPDATE plots SET status='COMPANY',buyer_name='COMPANY',buyer_member_id=NULL WHERE id=12");
    }
    assert.match(f.calls.find(({ sql }) => sql.includes('FROM plots')).sql, /FOR UPDATE/);
    assertWebsiteNotQueried(f.calls);
  } finally { await f.close(); }
});

test('pending cheque intent and later clearance ignore website holds and preserve the original buyer', async () => {
  const f = await fixture();
  try {
    const website = await f.websiteState();
    const result = await withCompanyPlotBooking({ ...f.options, deferBooking:true });
    assert.equal(result.bookedPlot, null);
    assert.equal((await f.state()).plot.status, 'COMPANY');
    assert.equal(result.result.rows[0].pending_booking_member_id, 8);
    await f.client.query('BEGIN');
    await completeDeferredChequeBooking(f.client, { ...result.result.rows[0], created_by:1, date:'2026-10-12' });
    await f.client.query('COMMIT');
    const state = await f.state();
    assert.equal(state.plot.status, 'BOOKED');
    assert.equal(state.plot.buyer_member_id, 8);
    assert.equal(state.plot.assigned_admin_id, 7);
    assert.equal(state.payments[0].pending_booking_member_id, null);
    assert.deepEqual(await f.websiteState(), website);
    assertWebsiteNotQueried(f.calls);
  } finally { await f.close(); }
});

test('direct status edits and caller-owned approval transactions do not depend on website tables', async () => {
  const f = await fixture();
  try {
    const website = await f.websiteState();
    for (const status of ['BOOKED', 'CANCELLED', 'COMPANY']) {
      const plot = await plotModel.update(12, { status }, f.pool);
      assert.equal(plot.status, status);
      assert.equal(f.calls.at(-1).sql, 'COMMIT');
    }
    await f.client.query('BEGIN');
    await plotModel.update(12, { status:'BOOKED' }, f.client);
    assert.match(f.calls.at(-1).sql, /^UPDATE plots/);
    await f.client.query('ROLLBACK');
    assert.equal((await f.state()).plot.status, 'COMPANY', 'the caller still owns rollback');
    assert.deepEqual(await f.websiteState(), website);
    assertWebsiteNotQueried(f.calls);
  } finally { await f.close(); }
});

test('payment failure still rolls back the Accounts booking without changing the website request', async () => {
  const f = await fixture();
  try {
    const website = await f.websiteState();
    await assert.rejects(withCompanyPlotBooking({ ...f.options, savePayment:async db => {
      await f.options.savePayment(db);
      throw new Error('Payment failed');
    } }), /Payment failed/);
    const state = await f.state();
    assert.equal(state.plot.status, 'COMPANY');
    assert.deepEqual(state.payments, []);
    assert.equal(f.calls.at(-1).sql, 'ROLLBACK');
    assert.deepEqual(await f.websiteState(), website);
    assertWebsiteNotQueried(f.calls);
  } finally { await f.close(); }
});

test('Accounts still rejects already booked plots and inactive buyers independently of website requests', async () => {
  const f = await fixture();
  try {
    await f.engine.exec("UPDATE plots SET status='BOOKED' WHERE id=12");
    await assert.rejects(withCompanyPlotBooking(f.options), { code:'PLOT_BOOKING_CHANGED' });
    await f.engine.exec("UPDATE plots SET status='COMPANY' WHERE id=12; UPDATE members SET status='INACTIVE'");
    await assert.rejects(withCompanyPlotBooking(f.options), { code:'BOOKING_CLIENT_UNAVAILABLE' });
    assert.deepEqual((await f.state()).payments, []);
    assertWebsiteNotQueried(f.calls);
  } finally { await f.close(); }
});

test('installations without website tables continue to support booking and status changes', async () => {
  const f = await fixture({ websiteTable:false });
  try {
    const result = await withCompanyPlotBooking(f.options);
    assert.equal(result.bookedPlot.status, 'BOOKED');
    await plotModel.update(13, { status:'BOOKED' }, f.pool);
    assert.equal((await f.engine.query('SELECT status FROM plots WHERE id=13')).rows[0].status, 'BOOKED');
    assertWebsiteNotQueried(f.calls);
  } finally { await f.close(); }
});

test('legacy NOC approval promotes only its own project plot despite a website hold', async () => {
  const f = await fixture();
  try {
    const website = await f.websiteState();
    await f.engine.exec("INSERT INTO plot_registries(id,site_id,plot_no,noc_generated_at,registry_payment) VALUES(100,5,'a01',now(),0)");
    const registry = (await f.engine.query('SELECT *,0 AS total_paid FROM plot_registries')).rows[0];
    const source = readFileSync(new URL('../src/controllers/registry.controller.js', import.meta.url), 'utf8');
    const code = source.slice(source.indexOf('export const approveRegistryNoc'), source.indexOf('/** GET /registries/:id/noc — one-shot')).replace('export const ', 'const ');
    const query = async (sql, params) => sql.includes('SELECT pr.*,') ? { rows:[registry] } : f.client.query(sql, params);
    const ctx = vm.createContext({ pool:{ connect:async () => ({ query, release() {} }) }, asyncHandler:fn => fn,
      registryCoverageSql:'0', readRegistryWorkflowUnlocked:async () => false });
    vm.runInContext(`${code}\nthis.approve = approveRegistryNoc;`, ctx);
    let body;
    await ctx.approve({ params:{ id:100 }, user:{ id:7 } }, { json(value) { body = value; } });
    assert.equal(body.plot_status_updated, true);
    assert.equal(body.registry.noc_approved_by, 7);
    assert.equal((await f.state()).plot.status, 'REGISTRY');
    assert.equal((await f.engine.query('SELECT status FROM plots WHERE id=13')).rows[0].status, 'COMPANY');
    assert.equal(f.calls.at(-1).sql, 'COMMIT');
    assert.deepEqual(await f.websiteState(), website);
    assertWebsiteNotQueried(f.calls);
  } finally { await f.close(); }
});
