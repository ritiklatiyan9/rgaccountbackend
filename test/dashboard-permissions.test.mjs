import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { graphql } from 'graphql';
import pool from '../src/config/db.js';
import { schema } from '../src/graphql/schema.js';
import { cacheSet, clearCacheByPrefixes } from '../src/config/cache.js';
import { ALL_COMPONENTS, dashboardComponentAllowed, loadDashboardPermissions } from '../src/services/dashboardPermissions.service.js';
import { updateDashboardPermissions, getDashboardPermissions, listUsersWithDashboardPermissions } from '../src/controllers/dashboardPermission.controller.js';
import { requireDashboardComponent } from '../src/middlewares/dashboardComponent.middleware.js';

const admin = { id: 1, role: 'admin', organization_id: 1 };
const staff = { id: 2, role: 'sub_admin', organization_id: 1 };
const context = user => ({ user, permissions: new Map([['dashboard', { can_read: true }]]), siteIds: new Set([5]) });
async function fixture(t) {
  const db = new PGlite();
  await db.exec(`CREATE TABLE users(id int PRIMARY KEY, name text, email text, role text, organization_id int, is_active boolean);
    INSERT INTO users VALUES (1,'Admin','admin@test','admin',1,true),(2,'Staff','staff@test','sub_admin',1,true),(3,'Other','other@test','sub_admin',2,true),(4,'Inactive','inactive@test','sub_admin',1,false);
    CREATE TABLE dashboard_component_permissions(user_id int,component text,allowed boolean,updated_at timestamptz DEFAULT NOW(),UNIQUE(user_id,component));`);
  const query = pool.query, connect = pool.connect;
  const reads = [];
  pool.query = (sql, args) => { reads.push(sql); return db.query(sql, args); };
  pool.connect = async () => ({ query: (sql, args) => db.query(sql, args), release() {} });
  await clearCacheByPrefixes(['dashboard:']);
  t.after(async () => { pool.query = query; pool.connect = connect; await clearCacheByPrefixes(['dashboard:']); await db.close(); });
  return { db, reads };
}
function request(handler, body = {}, userId = 2) {
  return new Promise((resolve, reject) => {
    const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(payload) { resolve({ status: this.statusCode, payload }); } };
    handler({ params: { userId: String(userId) }, body, user: admin }, res, reject);
  });
}
const source = `{ revenueVsExpense(siteId:5, range:{start:"2026-01-01",end:"2027-01-01"}, resolution:MONTH){date label revenue expense value}
  profitTrend(siteId:5, range:{start:"2026-01-01",end:"2027-01-01"}, resolution:MONTH){value} }`;
async function primeChart() {
  await cacheSet('dashboard:chart-rve-MONTH:5:2026-01-01:2027-01-01', [{ date: '2026-01-01', label: 'Jan', revenue: 100, expense: 30 }]);
}

test('new card permissions save as booleans and round-trip for only the selected team member', async t => {
  const { db } = await fixture(t);
  const saved = await request(updateDashboardPermissions, { permissions: { peak_revenue: false, peak_expenses: true, profit_trend: false } });
  assert.equal(saved.status, 200);
  assert.equal(saved.payload.permissions.peak_revenue, false);
  assert.equal(saved.payload.permissions.peak_expenses, true);
  assert.ok(ALL_COMPONENTS.includes('tds_summary'));
  const loaded = await request(getDashboardPermissions);
  assert.equal(loaded.payload.permissions.peak_revenue, false);
  assert.equal((await db.query('SELECT DISTINCT user_id FROM dashboard_component_permissions')).rows.length, 1);
  const team = await request(listUsersWithDashboardPermissions);
  assert.deepEqual(team.payload.users.map(row => row.id).sort(), [1, 2]);
});

test('malformed permissions, protected admin accounts and other organizations cannot be changed', async t => {
  const { db } = await fixture(t);
  for (const permissions of [[], null, { peak_revenue: 'false' }, { peak_expenses: 0 }, { unknown: true }]) {
    assert.equal((await request(updateDashboardPermissions, { permissions })).status, 400);
  }
  for (const id of ['2junk', '-1', '1.5']) assert.equal((await request(updateDashboardPermissions, { permissions: { peak_revenue: false } }, id)).status, 400);
  assert.equal((await request(updateDashboardPermissions, { permissions: { peak_revenue: false } }, 1)).status, 400);
  assert.equal((await request(updateDashboardPermissions, { permissions: { peak_revenue: false } }, 3)).status, 404);
  assert.equal((await request(getDashboardPermissions, {}, 3)).status, 404);
  assert.equal((await db.query('SELECT * FROM dashboard_component_permissions')).rows.length, 0);
});

test('parents and data dependencies take precedence, while admin access remains inherited', () => {
  assert.equal(dashboardComponentAllowed(staff, {}, 'peak_revenue'), true);
  for (const key of ['peak_revenue', 'peak_expenses', 'profit_trend', 'revenue_comparison']) assert.equal(dashboardComponentAllowed(staff, { revenue_charts: false }, key), false);
  assert.equal(dashboardComponentAllowed(staff, { peak_revenue: false }, 'peak_expenses'), true);
  for (const key of ['profit_trend', 'revenue_comparison']) assert.equal(dashboardComponentAllowed(staff, { peak_expenses: false }, key), false);
  assert.equal(dashboardComponentAllowed(staff, { financial_overview: false }, 'kpi_totalExpense'), false);
  assert.equal(dashboardComponentAllowed(staff, { kpi_totalExpense: false }, 'verify_panel'), false);
  assert.equal(dashboardComponentAllowed(admin, { revenue_charts: false, peak_revenue: false }, 'peak_revenue'), true);
});

test('GraphQL redacts a denied series and derived profit even when the shared chart cache is warm', async t => {
  const { db, reads } = await fixture(t);
  // Match the real cache namespace, populated by an administrator request.
  await primeChart();
  await db.query("INSERT INTO dashboard_component_permissions VALUES(2,'peak_revenue',false,NOW())");
  const result = await graphql({ schema, source, contextValue: context(staff) });
  assert.equal(result.errors, undefined, JSON.stringify(result.errors));
  assert.equal(result.data.revenueVsExpense[0].revenue, null);
  assert.equal(result.data.revenueVsExpense[0].expense, 30);
  assert.equal(result.data.profitTrend, null);
  assert.equal(reads.filter(sql => sql.includes('dashboard_component_permissions')).length, 1, 'one permission read for parallel fields');
  const privileged = await graphql({ schema, source, contextValue: context(admin) });
  assert.equal(privileged.errors, undefined, JSON.stringify(privileged.errors));
  assert.equal(privileged.data.revenueVsExpense[0].revenue, 100, 'redaction never mutates shared cached reports');
  assert.equal(privileged.data.profitTrend[0].value, 70);
});

test('revocations apply on the next request and blocked KPI fields need no financial query', async t => {
  const { db, reads } = await fixture(t);
  await db.query("INSERT INTO dashboard_component_permissions VALUES(2,'revenue_charts',false,NOW()),(2,'kpi_totalExpense',false,NOW())");
  const result = await graphql({ schema, source: `${source.slice(0, -1)} kpiCards(siteId:5,range:{start:"2026-01-01",end:"2027-01-01"}){totalExpense runningExpense} }`, contextValue: context(staff) });
  assert.equal(result.errors, undefined, JSON.stringify(result.errors));
  assert.equal(result.data.revenueVsExpense, null);
  assert.equal(result.data.kpiCards.totalExpense, null);
  assert.equal(result.data.kpiCards.runningExpense, null);
  assert.ok(reads.every(sql => sql.includes('dashboard_component_permissions')));
  await db.query("UPDATE dashboard_component_permissions SET allowed=true WHERE component='revenue_charts'");
  assert.equal((await loadDashboardPermissions(context(staff))).revenue_charts, true);
});

test('partial KPI access preserves permitted nested figures and strips denied cached fields', async t => {
  const { db } = await fixture(t);
  await db.query("INSERT INTO dashboard_component_permissions VALUES(2,'kpi_totalExpense',false,NOW())");
  const report = { currentProfit: 70, plotIncoming: { received: 100 }, totalExpense: 30, runningExpense: 30 };
  const key = 'dashboard:kpi-cards-v9:currentProfit,plotIncoming,plotIncoming.received:5:2026-01-01:2027-01-01';
  await cacheSet(key, report);
  const result = await graphql({ schema, source: '{kpiCards(siteId:5,range:{start:"2026-01-01",end:"2027-01-01"}){currentProfit plotIncoming{received} totalExpense runningExpense}}', contextValue: context(staff) });
  assert.equal(result.errors, undefined, JSON.stringify(result.errors));
  assert.equal(result.data.kpiCards.currentProfit, 70);
  assert.equal(result.data.kpiCards.plotIncoming.received, 100);
  assert.equal(result.data.kpiCards.totalExpense, null);
  assert.equal(result.data.kpiCards.runningExpense, null);
  assert.equal(report.totalExpense, 30, 'the shared cached report remains unmodified');
});

test('recent-transactions API stops a denied user before reading transactions', async t => {
  const { db } = await fixture(t);
  await db.query("INSERT INTO dashboard_component_permissions VALUES(2,'recent_transactions',false,NOW())");
  const result = await new Promise((resolve, reject) => requireDashboardComponent('recent_transactions')({ user: staff },
    { status(code) { this.code = code; return this; }, json(body) { resolve({ code: this.code, body }); } }, error => error ? reject(error) : reject(new Error('Denied request reached financial handler'))));
  assert.equal(result.code, 403);
});
