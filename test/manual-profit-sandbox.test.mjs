import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { cleanDocument } from '../src/controllers/manualProfitSandbox.controller.js';

test('manual sandbox input is normalized without accepting live accounting data', () => {
  const result = cleanDocument({
    version: 99,
    asOf: '2026-09-14',
    dashboardProfit: 999999,
    sites: [{
      id: 'draft-1', siteId: 7, siteName: '  Planning Site  ', plotSaleValue: '1000',
      plotReceived: 250, landBookProfit: 100, landReceived: 20, paidLandCost: 50,
      runningExpenses: 40, liveProfit: 123456,
      partners: [{ id: 'p-1', name: '  Aman  ', sharePct: 25, paid: 10, memberId: 123 }],
    }],
  });

  assert.equal(result.version, 1);
  assert.equal(result.sites[0].siteName, 'Planning Site');
  assert.equal(result.sites[0].plotSaleValue, 1000);
  assert.deepEqual(Object.keys(result.sites[0]).sort(), [
    'id', 'landBookProfit', 'landReceived', 'paidLandCost', 'partners', 'plotReceived',
    'plotSaleValue', 'runningExpenses', 'siteId', 'siteName',
  ].sort());
  assert.deepEqual(Object.keys(result.sites[0].partners[0]).sort(), ['id', 'name', 'paid', 'sharePct']);
});

test('manual sandbox rejects negative money and out-of-range shares', () => {
  assert.throws(() => cleanDocument({ sites: [{ siteName: 'A', runningExpenses: -1, partners: [] }] }), /between 0/);
  assert.throws(() => cleanDocument({ sites: [{ siteName: 'A', partners: [{ name: 'B', sharePct: 101 }] }] }), /between 0 and 100/);
});

test('migration has no accounting triggers and dashboard code does not reference sandbox storage', async () => {
  const migration = await readFile(new URL('../src/migrations/167_manual_profit_sandboxes.js', import.meta.url), 'utf8');
  const dashboard = await readFile(new URL('../src/graphql/schema.js', import.meta.url), 'utf8');
  assert.doesNotMatch(migration, /CREATE\s+TRIGGER/i);
  assert.doesNotMatch(migration, /cash_flow_entries|ledger_entries|partner_profit_payments/i);
  assert.doesNotMatch(dashboard, /manual_profit_sandboxes/i);
});
