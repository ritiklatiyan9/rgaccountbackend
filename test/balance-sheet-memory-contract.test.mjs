import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const readFrontend = (path) => readFile(new URL(`../../rgaccount/${path}`, import.meta.url), 'utf8');

test('balance sheet does not aggregate transaction history into one PostgreSQL JSON value', async () => {
  const model = await read('src/models/BalanceSheet.model.js');
  assert.match(model, /REPORT_META_QUERY/);
  assert.match(model, /REPORT_TRANSACTIONS_QUERY/);
  assert.doesNotMatch(model, /jsonb_agg\(\s*to_jsonb\(tx\)/);
  assert.match(model, /await pool\.query\(REPORT_META_QUERY, params\)[\s\S]*?await pool\.query\(REPORT_TRANSACTIONS_QUERY, params\)/);
});

test('statement APIs and clients enforce the 12k memory safety ceiling', async () => {
  const controller = await read('src/controllers/balanceSheet.controller.js');
  const daybook = await readFrontend('src/pages/DayBook.jsx');
  const balanceSheet = await readFrontend('src/pages/BalanceSheet.jsx');

  assert.match(controller, /MAX_STATEMENT_ROWS = 12000/);
  assert.match(controller, /getReportSingleFlight/);
  assert.match(daybook, /limit: '12000'/);
  assert.match(balanceSheet, /limit: '12000'/);
});

test('Day Book plot options use the compact database projection', async () => {
  const model = await read('src/models/Plot.model.js');
  const controller = await read('src/controllers/daybook.controller.js');

  assert.match(model, /findOptionsBySiteId/);
  assert.match(model, /SELECT p\.id, p\.plot_no, p\.block, p\.buyer_name, p\.sale_price/);
  assert.match(controller, /plotModel\.findOptionsBySiteId/);
});
