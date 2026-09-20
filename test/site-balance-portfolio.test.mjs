import test from 'node:test';
import assert from 'node:assert/strict';
import { getAccessibleSiteBalances } from '../src/graphql/services/kpi.service.js';

test('portfolio balance performs one grouped query and normalises money', async () => {
  const calls = [];
  const db = { query: async (sql, params) => {
    calls.push({ sql, params });
    return { rows: [
      { site_id: '2', cash_balance: '10.125', bank_balance: '-3.456' },
      { site_id: 7, cash_balance: null, bank_balance: '0' },
    ] };
  } };

  const balances = await getAccessibleSiteBalances(41, false, '2026-09-22', db);

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].params, [41, false, '2026-09-22']);
  assert.match(calls[0].sql, /WITH accessible_sites AS MATERIALIZED/);
  assert.match(calls[0].sql, /GROUP BY le\.site_id/);
  assert.deepEqual(balances, [
    { site_id: 2, cash_balance: 10.13, bank_balance: -3.46 },
    { site_id: 7, cash_balance: 0, bank_balance: 0 },
  ]);
});

test('portfolio query grants global reads only to callers selected by the controller', async () => {
  let parameters;
  const db = { query: async (_sql, params) => { parameters = params; return { rows: [] }; } };
  await getAccessibleSiteBalances(3, true, '2026-09-22', db);
  assert.deepEqual(parameters, [3, true, '2026-09-22']);
});
