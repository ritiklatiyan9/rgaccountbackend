import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { PGlite } from '@electric-sql/pglite';
import { assertNoWebsitePlotHold, assertRegistryWebsitePlotNotHeld } from '../src/services/websitePlotHold.service.js';
import { withCompanyPlotBooking, completeDeferredChequeBooking } from '../src/services/quickPlotBooking.service.js';
import { plotModel } from '../src/models/Plot.model.js';

// Isolated PostgreSQL engine only; never loads application database credentials
// for queries or changes live inventory, customers or payment records.
async function fixture({ websiteTable = true } = {}) {
  const engine = new PGlite();
  await engine.exec(`CREATE TABLE plots(id integer PRIMARY KEY,site_id integer,plot_no text,status text,buyer_name text,
    buyer_member_id integer,booking_date date,assigned_admin_id integer,approval_requested_by integer,created_by integer,updated_at timestamptz);
    CREATE TABLE members(id integer PRIMARY KEY,site_id integer,status text,full_name text);
    CREATE TABLE users(id integer PRIMARY KEY,is_active boolean,role text);
    CREATE TABLE user_sites(user_id integer,site_id integer);
    CREATE TABLE plot_payments(id integer PRIMARY KEY,plot_id integer,amount numeric,pending_booking_member_id integer,buyer_name text,assigned_admin_id integer);
    INSERT INTO plots VALUES(12,5,'A01','COMPANY','COMPANY',NULL,NULL,7,NULL,1,now()),(13,6,'A01','COMPANY','COMPANY',NULL,NULL,7,NULL,1,now());
    INSERT INTO members VALUES(8,5,'ACTIVE','Buyer'); INSERT INTO users VALUES(7,true,'admin');`);
  if (websiteTable) await engine.exec(`CREATE TABLE website_booking_requests(id serial PRIMARY KEY,plot_id integer,status text,hold_expires_at timestamptz);
    INSERT INTO website_booking_requests(plot_id,status,hold_expires_at) VALUES(12,'AWAITING_PAYMENT',now()+interval '15 minutes');`);
  const calls = [];
  const query = async (sql, params) => { calls.push({ sql, params }); return engine.query(sql, params); };
  const client = { query, release() {} }, pool = { query, connect: async () => client };
  const options = { pool,plotId:12,memberId:8,date:'2026-10-12',savePayment: db => db.query('INSERT INTO plot_payments(id,plot_id,amount) VALUES(24,12,1000) RETURNING *') };
  const state = async () => ({ plot:(await engine.query('SELECT * FROM plots WHERE id=12')).rows[0], payments:(await engine.query('SELECT * FROM plot_payments')).rows });
  return { engine, pool, client, calls, options, state, close: () => engine.close() };
}

test('Accounts quick booking and deferred payment intent cannot consume an active website hold', async () => {
  const f = await fixture();
  try {
    for (const deferBooking of [false,true]) {
      await assert.rejects(withCompanyPlotBooking({ ...f.options,deferBooking }), { status:409,code:'WEBSITE_PLOT_HELD' });
      const state = await f.state(); assert.equal(state.plot.status,'COMPANY'); assert.deepEqual(state.payments,[]);
      assert.equal(f.calls.at(-1).sql,'ROLLBACK');
    }
    const locked = f.calls.findIndex(call => call.sql.includes('FROM plots'));
    const held = f.calls.findIndex(call => call.sql.includes('FROM website_booking_requests'));
    assert.match(f.calls[locked].sql,/FOR UPDATE/); assert.ok(locked < held);
  } finally { await f.close(); }
});

test('deferred cheque clearance preserves its intent and Company plot when a website hold has since appeared', async () => {
  const f = await fixture();
  try {
    await f.engine.exec('INSERT INTO plot_payments VALUES(24,12,1000,8,\'BUYER\',7)');
    await f.client.query('BEGIN');
    await assert.rejects(completeDeferredChequeBooking(f.client,{id:24,plot_id:12,pending_booking_member_id:8,assigned_admin_id:7,created_by:1,date:'2026-10-12'}), { statusCode:409,code:'WEBSITE_PLOT_HELD' });
    await f.client.query('ROLLBACK');
    const state = await f.state(); assert.equal(state.plot.status,'COMPANY'); assert.equal(state.payments[0].pending_booking_member_id,8);
    assert.equal(f.calls.some(call => call.sql.startsWith('UPDATE ')),false);
  } finally { await f.close(); }
});

test('direct status saves and approved edit transactions respect the same active hold', async () => {
  const f = await fixture();
  try {
    for (const status of ['BOOKED','REGISTRY','CANCELLED','COMPANY']) {
      await assert.rejects(plotModel.update(12,{status},f.pool), { code:'WEBSITE_PLOT_HELD' });
      assert.equal((await f.state()).plot.status,'COMPANY');
    }
    await f.client.query('BEGIN');
    await assert.rejects(plotModel.update(12,{status:'BOOKED'},f.client),{code:'WEBSITE_PLOT_HELD'});
    assert.notEqual(f.calls.at(-1).sql,'ROLLBACK','caller-owned transactions remain caller-owned');
    await f.client.query('ROLLBACK');
  } finally { await f.close(); }
});

test('paid requests remain reserved after timeout; expired or reviewed unpaid requests release the plot', async () => {
  const f = await fixture();
  try {
    for (const status of ['ORDER_CREATING','AWAITING_PAYMENT','PAYMENT_REVIEW']) {
      await f.engine.query("UPDATE website_booking_requests SET status=$1,hold_expires_at=now()+interval '1 minute'",[status]);
      await assert.rejects(assertNoWebsitePlotHold(f.client,12),{code:'WEBSITE_PLOT_HELD'});
    }
    await f.engine.exec("UPDATE website_booking_requests SET status='PAYMENT_REVIEW',hold_expires_at=now()-interval '1 hour'");
    await assert.rejects(assertNoWebsitePlotHold(f.client,12),{code:'WEBSITE_PLOT_HELD'});
    for (const status of ['ORDER_CREATING','AWAITING_PAYMENT','APPROVED','REJECTED','EXPIRED','PAYMENT_FAILED','PAYMENT_CONFLICT']) {
      await f.engine.query("UPDATE website_booking_requests SET status=$1,hold_expires_at=now()-interval '1 minute'",[status]);
      await assertNoWebsitePlotHold(f.client,12);
    }
    const result = await withCompanyPlotBooking(f.options); assert.equal(result.bookedPlot.status,'BOOKED');
    assert.equal((await f.state()).payments.length,1);
  } finally { await f.close(); }
});

test('older installations without website tables keep normal booking and status saves working', async () => {
  const f = await fixture({ websiteTable:false });
  try {
    const result = await withCompanyPlotBooking(f.options); assert.equal(result.bookedPlot.status,'BOOKED');
    await plotModel.update(13,{status:'BOOKED'},f.pool);
    assert.equal((await f.engine.query('SELECT status FROM plots WHERE id=13')).rows[0].status,'BOOKED');
    assert.equal(f.calls.some(call => call.sql.includes('FROM website_booking_requests')),false);
  } finally { await f.close(); }
});

test('legacy NOC approval resolves the same locked plot, respects project identity and rolls back held promotion', async () => {
  const f = await fixture();
  try {
    await f.client.query('BEGIN');
    await assert.rejects(assertRegistryWebsitePlotNotHeld(f.client,{plot_id:null,site_id:5,plot_no:'a01'}),{code:'WEBSITE_PLOT_HELD'});
    await f.client.query('ROLLBACK');
    await assertRegistryWebsitePlotNotHeld(f.client,{plot_id:null,site_id:6,plot_no:'A01'});
    const source = readFileSync(new URL('../src/controllers/registry.controller.js',import.meta.url),'utf8');
    const code = source.slice(source.indexOf('export const approveRegistryNoc'),source.indexOf('/** GET /registries/:id/noc — one-shot')).replace('export const ','const ');
    const registry = {id:100,plot_id:null,site_id:5,plot_no:'A01',noc_generated_at:new Date(),noc_approved_at:null,registry_payment:0,total_paid:0};
    const query = async (sql,params) => sql.includes('SELECT pr.*,') ? {rows:[registry]} : f.client.query(sql,params);
    const ctx = vm.createContext({pool:{connect:async()=>({query,release(){}})},asyncHandler: fn=>fn,registryCoverageSql:'0',readRegistryWorkflowUnlocked:async()=>false,assertRegistryWebsitePlotNotHeld});
    vm.runInContext(`${code}\nthis.approve = approveRegistryNoc;`,ctx);
    await assert.rejects(ctx.approve({params:{id:100},user:{id:7}},{status(){return this;},json(){}}),{code:'WEBSITE_PLOT_HELD'});
    assert.equal(f.calls.at(-1).sql,'ROLLBACK'); assert.equal((await f.state()).plot.status,'COMPANY');
  } finally { await f.close(); }
});
