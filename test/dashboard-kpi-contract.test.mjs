import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const readBackend = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const readFrontend = (path) => readFile(new URL(`../../rgaccount/${path}`, import.meta.url), 'utf8');

test('dashboard profit cards use cumulative plot and land positions with one running-expense deduction', async () => {
  const service = await readBackend('src/graphql/services/kpi.service.js');

  assert.match(service, /const expectedProfit = plotIncoming\.finalSaleValue[\s\S]*?\+ landProfitDetail\.bookProfit[\s\S]*?- runningExpense[\s\S]*?\+ landProfitDetail\.purchaseCostAlreadyExpensed/);
  const expectedFormula = service.slice(service.indexOf('const expectedProfit'), service.indexOf('const currentProfit'));
  assert.doesNotMatch(expectedFormula, /plotIncoming\.received/);
  assert.match(service, /const currentProfit = plotIncoming\.received \+ landProfitDetail\.received - runningExpense/);
  assert.match(service, /netProfit:\s*roundMoney\(periodNetProfit\)/);
  assert.match(service, /currentProfitMargin:\s*roundPct\(currentProfitMargin\)/);
  assert.match(service, /SUM\(GREATEST\(sale_value - received, 0\)\)/);
  assert.match(service, /SUM\(GREATEST\(received - sale_value, 0\)\)/);
  assert.match(service, /pricing_plots AS \([\s\S]*?p\.site_id = \$1[\s\S]*?p\.plot_tag[\s\S]*?<> 'OLD'/);
  assert.match(service, /SUM\(sale_value\) FROM pricing_plots[\s\S]*?AS final_sale_value/);
  assert.match(service, /finalSaleValue:\s*roundMoney\(finalSaleValue\)/);
  assert.match(service, /LEAST\([\s\S]*?sold_purchase_cost[\s\S]*?posted_cost/);
  assert.match(service, /LOWER\(TRIM\(COALESCE\(d\.status, ''\)\)\) IN \('open', 'completed'\)/);
});

test('Admin Site Balance keeps full custody while only uncommitted cash is distributable', async () => {
  const service = await readBackend('src/graphql/services/kpi.service.js');
  const start = service.indexOf('export async function getSiteBalanceDetail');
  const end = service.indexOf('export async function getSiteBalance(', start);
  const implementation = service.slice(start, end);

  assert.match(implementation, /ledger\.balance_before_imprest - imprest\.imprest_held AS site_balance/);
  assert.match(implementation, /ledger\.cash_balance - imprest\.imprest_held[\s\S]*?- pending\.pending_imprest_reservations AS distributable_balance/);
  assert.match(implementation, /0::numeric AS admin_imprest_reserved/);
  assert.doesNotMatch(implementation, /- imprest\.admin_imprest_reserved/);
  assert.match(implementation, /role NOT IN \('admin', 'super_admin'\)/);
  assert.match(implementation, /status = 'PENDING_RECEIPT'/);
  assert.match(implementation, /entry_date >= \$2::date AND entry_date < \$3::date/);
});

test('registry and frontend contracts expose cash, bank, remaining balance, land profit, and distributable balance', async () => {
  const service = await readBackend('src/graphql/services/kpi.service.js');
  const schema = await readBackend('src/graphql/schema.js');
  const query = await readFrontend('src/graphql/queries.js');
  const dashboard = await readFrontend('src/pages/Dashboard.jsx');

  assert.match(service, /source_key IN \('plot_payments', 'plot_installment_payments'\)/);
  assert.match(service, /UPPER\(TRIM\(COALESCE\(p\.status, ''\)\)\) = 'REGISTRY'/);
  assert.match(service, /le\.bucket/);
  assert.match(service, /SUM\(amount\) FILTER \(WHERE bucket = 'cash'\)/);
  assert.match(service, /SUM\(amount\) FILTER \(WHERE bucket <> 'cash'\)/);

  for (const field of [
    'plotIncoming', 'finalSaleValue', 'matchedReceived', 'unmatchedReceived', 'landProfitDetail',
    'purchaseCostAlreadyExpensed', 'registryPaymentDetail', 'runningExpense',
    'expectedProfit', 'currentProfit', 'adminImprestReserved',
    'pendingImprestReservations', 'distributableBalance',
  ]) {
    assert.match(schema, new RegExp(`\\b${field}\\b`), `schema is missing ${field}`);
    assert.match(query, new RegExp(`\\b${field}\\b`), `frontend query is missing ${field}`);
  }

  assert.match(dashboard, /navigate\('\/farmers\/land-profit'\)/);
  assert.match(dashboard, /finalPlotSaleValue[\s\S]*?Plot Payments sale price \(100%\)/);
  assert.match(dashboard, /eligiblePlotSaleValue[\s\S]*?Eligible collection book/);
  assert.match(dashboard, /Plot Payments Pricing sale price \(not received money\)/);
  assert.match(dashboard, /kpiKey="plotPayments"[\s\S]*?Remaining balance/);
  assert.match(dashboard, /kpiKey="registryPayments"[\s\S]*?\+ Bank/);
});
