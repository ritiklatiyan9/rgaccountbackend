import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import pool from '../src/config/db.js';
import { up } from '../src/migrations/224_site_overall_switch.js';
import { postingPolicySql } from '../src/migrations/171_cheque_clearance_before_approval.js';
import { updateSite } from '../src/controllers/site.controller.js';
import { listAllSitesCommissions } from '../src/controllers/plotCommissionV2.controller.js';
import { listPersonalLedgerPortfolio } from '../src/controllers/cashflow.controller.js';
import { cashFlowMonthModel } from '../src/models/CashFlow.model.js';
import { requireOverallSiteScope } from '../src/middlewares/overallSiteScope.middleware.js';
import { cacheResponse, buildCacheKey } from '../src/middlewares/cache.middleware.js';
import { cacheGet, cacheSet } from '../src/config/cache.js';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const invoke = (handler, req) => new Promise((resolve, reject) => handler(req, {
  status(code) { this.code = code; return this; },
  json(body) { resolve({ status: this.code || 200, body }); },
}, reject));
const commissionSites = async () => (await invoke(listAllSitesCommissions, { query: {} })).body.commissions.map((row) => row.site_id);
const switchSite = (id, include) => invoke(updateSite, { params: { id: String(id) }, body: { include_in_overall: include } });
const cachedPortfolio = async (namespace, handler) => {
  const req = { method: 'GET', path: '/portfolio', headers: {}, query: {}, user: { id: 1, role: 'admin' } };
  await new Promise((resolve, reject) => requireOverallSiteScope(req, {}, error => error ? reject(error) : resolve()));
  const key = buildCacheKey(req, namespace);
  return new Promise((resolve, reject) => {
    const headers = {};
    const res = { statusCode: 200, setHeader(name, value) { headers[name] = value; },
      status(code) { this.statusCode = code; return this; },
      json(body) { resolve({ body, key, cache: headers['X-Cache'] }); } };
    cacheResponse({ namespace, ttlSeconds: 60 })(req, res, () => handler(req, res, reject)).catch(reject);
  });
};


test('a site switched off on the Sites page leaves the all-sites commission and personal-ledger portfolios', async () => {
  const pg = new PGlite();
  const originalQuery = pool.query, originalConnect = pool.connect;
  const query = async (sql, args) => (args?.length ? pg.query(sql, args) : (await pg.exec(sql)).at(-1) || { rows: [] });
  pool.query = query; pool.connect = async () => ({ query, release() {} });
  try {
    await pg.exec(`
      CREATE TABLE app_schema_migrations(version text PRIMARY KEY);
      CREATE TABLE sites(id int PRIMARY KEY, name text, code text, status text DEFAULT 'active', created_at timestamptz DEFAULT now());
      INSERT INTO sites(id, name, code) VALUES (1, 'Kept', 'K'), (2, 'Switched off', 'S');
      CREATE TABLE members(id int PRIMARY KEY, full_name text, phone text, team text, email text, member_type text);
      INSERT INTO members(id, full_name, phone) VALUES (10, 'Broker One', '9876543210'), (20, 'Broker One', '9876543210');
      CREATE TABLE plots(id int PRIMARY KEY, plot_no text, plot_size numeric, status text, buyer_name text);
      INSERT INTO plots VALUES (100, 'A-1', 100, 'BOOKED', 'Buyer A'), (200, 'B-1', 100, 'BOOKED', 'Buyer B');
      CREATE TABLE farmers(id int PRIMARY KEY, name text);
      CREATE TABLE land_deals(id int PRIMARY KEY, farmer_id int, buyer_name text);
      CREATE TABLE plot_commissions_v2(id int PRIMARY KEY, site_id int, agent_id int, plot_id int, farmer_id int, land_deal_id int,
        total_commission numeric, remarks text, created_at timestamptz DEFAULT now());
      INSERT INTO plot_commissions_v2(id, site_id, agent_id, plot_id, total_commission) VALUES (1, 1, 10, 100, 1000), (2, 2, 20, 200, 5000);
      CREATE TABLE plot_commission_payments(id int PRIMARY KEY, plot_commission_id int, amount numeric, tds_amount numeric DEFAULT 0,
        date date, payment_mode text, status text, cheque_status text);
      INSERT INTO plot_commission_payments VALUES (1, 1, 400, 0, '2026-01-05', 'BANK', 'approved', NULL), (2, 2, 2500, 0, '2026-01-06', 'CASH', 'approved', NULL);
      CREATE TABLE users(id int PRIMARY KEY, name text, email text, phone text, role text);
      CREATE TABLE cash_flow_months(id int PRIMARY KEY, site_id int, month int, year int, ledger_name text, ledger_type text,
        opening_balance numeric DEFAULT 0, linked_user_id int, linked_member_id int);
      INSERT INTO cash_flow_months(id, site_id, month, year, ledger_name, ledger_type)
        VALUES (1, 1, 1, 2026, 'RAM', 'person'), (2, 2, 1, 2026, 'SHYAM', 'person'), (3, 2, 1, 2026, 'SITE', 'site');
      CREATE TABLE cash_flow_entries(id int PRIMARY KEY, cash_flow_month_id int, debit numeric DEFAULT 0, credit numeric DEFAULT 0,
        cash_type text, status text, cheque_status text, created_by int, source_module text);
      INSERT INTO cash_flow_entries(id, cash_flow_month_id, debit, cash_type, status) VALUES (1, 1, 300, 'cash', 'approved'), (2, 2, 700, 'bank', 'approved');
    `);
    await pg.exec(read('../src/migrations/079_ledger_entries_view.js').match(/CREATE FUNCTION ledger_bucket\(raw text\)[\s\S]+?\$fn\$;/)[0]);
    await pg.exec(postingPolicySql);

    assert.equal(await up(pool), true);
    assert.equal(await up(pool), false, 'the migration is idempotent');
    assert.deepEqual(await commissionSites(), [1, 2], 'every existing site starts included');
    const commissionBefore = await cachedPortfolio('plot-commissions', listAllSitesCommissions);
    const personalBefore = await cachedPortfolio('cashflow', listPersonalLedgerPortfolio);
    assert.equal((await cachedPortfolio('plot-commissions', listAllSitesCommissions)).cache, 'HIT');
    assert.equal((await cachedPortfolio('cashflow', listPersonalLedgerPortfolio)).cache, 'HIT');

    assert.equal((await switchSite(2, 'false')).status, 400, 'only a real boolean is accepted');
    const off = await switchSite(2, false);
    assert.equal(off.status, 200);
    assert.equal(off.body.site.include_in_overall, false);
    assert.equal(await cacheGet(commissionBefore.key), null, 'switch response waits for commission invalidation');
    assert.equal(await cacheGet(personalBefore.key), null, 'switch response waits for personal-ledger invalidation');
    // Recreate a stale entry as if another process still held the old portfolio.
    // Live scope fingerprints must prevent it from being read after switching off.
    await cacheSet(commissionBefore.key, { statusCode: 200, payload: commissionBefore.body });
    await cacheSet(personalBefore.key, { statusCode: 200, payload: personalBefore.body });
    const commissionAfter = await cachedPortfolio('plot-commissions', listAllSitesCommissions);
    const personalAfter = await cachedPortfolio('cashflow', listPersonalLedgerPortfolio);
    assert.notEqual(commissionAfter.key, commissionBefore.key);
    assert.notEqual(personalAfter.key, personalBefore.key);
    assert.deepEqual(commissionAfter.body.commissions.map(row => row.site_id), [1]);
    assert.deepEqual(personalAfter.body.ledgers.map(row => row.site_id), [1]);
    assert.equal((await cachedPortfolio('plot-commissions', listAllSitesCommissions)).cache, 'HIT');

    assert.deepEqual(await commissionSites(), [1]);
    const { body } = await invoke(listPersonalLedgerPortfolio, {});
    assert.deepEqual(body.ledgers.map((row) => row.ledger_name), ['RAM']);
    // The switched-off site's own register and Personal Ledger report keep every ledger.
    assert.deepEqual((await cashFlowMonthModel.findBySiteId(2, pool)).map((row) => row.ledger_name).sort(), ['SHYAM', 'SITE']);
    assert.deepEqual((await cashFlowMonthModel.findBySiteId(2, pool, null, true)).map((row) => row.ledger_name), ['SHYAM']);

    await switchSite(2, true);
    assert.deepEqual(await commissionSites(), [1, 2]);
    assert.deepEqual((await cachedPortfolio('plot-commissions', listAllSitesCommissions)).body.commissions.map(row => row.site_id), [1, 2]);
    assert.deepEqual((await cachedPortfolio('cashflow', listPersonalLedgerPortfolio)).body.ledgers.map(row => row.site_id).sort(), [1, 2]);
    await switchSite(1, false); await switchSite(2, false);
    assert.deepEqual((await cachedPortfolio('plot-commissions', listAllSitesCommissions)).body.commissions, []);
    assert.deepEqual((await cachedPortfolio('cashflow', listPersonalLedgerPortfolio)).body.ledgers, []);
  } finally {
    pool.query = originalQuery; pool.connect = originalConnect;
    await pg.close();
  }
});
