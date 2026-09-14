import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('portfolio route is admin-only, cached, and ordered before dynamic commission routes', async () => {
  const source = await readFile(new URL('../src/routes/plotCommissionV2.routes.js', import.meta.url), 'utf8');
  const portfolio = source.indexOf("router.get('/portfolio'");
  const dynamic = source.indexOf("router.get('/:id'");
  assert.ok(portfolio > 0 && portfolio < dynamic);
  assert.match(source.slice(portfolio, source.indexOf('\n', portfolio)), /requireRole\('admin'\).*plotCommissionReadCache/);
});

test('portfolio query covers plot and land subjects and only posted payments', async () => {
  const source = await readFile(new URL('../src/controllers/plotCommissionV2.controller.js', import.meta.url), 'utf8');
  const start = source.indexOf('export const listAllSitesCommissions');
  const end = source.indexOf('/**\n * GET /plot-commission/:id', start);
  const portfolio = source.slice(start, end);
  assert.match(portfolio, /plot_id/);
  assert.match(portfolio, /farmer_id/);
  assert.match(portfolio, /land_deal_id/);
  assert.match(portfolio, /commissionPaymentPostsSql/);
  assert.match(portfolio, /payment_rollup/);
  assert.equal((portfolio.match(/pool\.query/g) || []).length, 1);
});

test('cross-site access path has dedicated broker and payment indexes', async () => {
  const source = await readFile(new URL('../src/migrations/169_all_sites_commission_indexes.js', import.meta.url), 'utf8');
  assert.match(source, /plot_commissions_v2\(agent_id, site_id, created_at DESC\)/);
  assert.match(source, /plot_commission_payments\(plot_commission_id, date DESC\)/);
});
