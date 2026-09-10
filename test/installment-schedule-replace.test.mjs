import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const read = (relativePath) => readFileSync(new URL(relativePath, import.meta.url), 'utf8');
const controller = read('../src/controllers/installment.controller.js');
const body = controller.slice(controller.indexOf('export const replaceInstallments'), controller.indexOf('export const updateInstallment ='));

test('replacing a schedule is atomic and takes a row lock on the plot', () => {
  assert.match(body, /await client\.query\('BEGIN'\)/);
  assert.match(body, /FROM plots WHERE id = \$1 FOR UPDATE/);
  assert.match(body, /await client\.query\('COMMIT'\)/);
  assert.match(body, /await client\.query\('ROLLBACK'\)/);
});

test('installments with directly linked payments are never deleted', () => {
  // The FK cascades plot_installment_payments → deleting such a row would delete money.
  assert.match(body, /FROM plot_installment_payments WHERE plot_id = \$1 AND installment_id IS NOT NULL/);
  assert.match(body, /status\(409\)/, 'a request that drops a paid-against row must be refused, not silently kept');
  assert.match(body, /DELETE FROM plot_installments WHERE plot_id = \$1 AND id <> ALL\(\$2::int\[\]\)/,
    'only rows not sent back by id are removed');
  assert.ok(body.indexOf('status(409)') < body.indexOf('DELETE FROM plot_installments'), 'the guard runs before any delete');
});

test('kept rows are updated in place and new rows inserted pending with zero paid', () => {
  assert.match(body, /UPDATE plot_installments SET installment_name=\$2, amount=\$3, due_date=\$4, sort_order=\$5/);
  assert.match(body, /WHERE id=\$1 AND plot_id=\$6/, 'an id from another plot must not be updatable');
  assert.match(body, /VALUES \(\$1,\$2,\$3,\$4,\$5,'pending',0\)/);
  assert.match(body, /refreshStatuses\(plotId, client\)/, 'statuses recompute inside the same transaction');
  assert.match(body, /installments_enabled = TRUE/);
});

test('every row is validated before the transaction opens', () => {
  assert.match(body, /installments\.length > 120/);
  assert.match(body, /parseFloat\(inst\?\.amount\) > 0/);
  assert.ok(body.indexOf('positive amount and a due date') < body.indexOf("await client.query('BEGIN')"));
});

test('the route is registered as PUT /:id/installments behind update permission', () => {
  const routes = read('../src/routes/plot.routes.js');
  assert.match(routes, /router\.put\('\/:id\/installments', requireRole\('admin', 'sub_admin'\), requirePermission\('plot_payments', 'update'\), accessByParamPlot, bustPlotCache, replaceInstallments\)/);
  assert.ok(routes.indexOf("router.put('/:id/installments'") < routes.indexOf("router.put('/installments/:instId'"),
    'the plot-scoped route must be declared before the single-installment route');
});
