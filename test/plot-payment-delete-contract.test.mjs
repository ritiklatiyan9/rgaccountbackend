import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const read = (relativePath) => readFileSync(new URL(relativePath, import.meta.url), 'utf8');

test('deleting a plot payment also removes its linked registry projection atomically', () => {
  const controller = read('../src/controllers/plot.controller.js');
  const deleteStart = controller.indexOf('export const deletePayment');
  const deleteBody = controller.slice(deleteStart);

  assert.match(deleteBody, /await client\.query\('BEGIN'\)/);
  assert.match(deleteBody, /DELETE FROM plot_registry_payments[\s\S]*source_plot_payment_id = \$1/);
  assert.match(deleteBody, /DELETE FROM plot_payments WHERE id = \$1 RETURNING id/);
  assert.match(deleteBody, /await client\.query\('COMMIT'\)/);
  assert.match(deleteBody, /await client\.query\('ROLLBACK'\)/);
  assert.ok(
    deleteBody.indexOf('DELETE FROM plot_registry_payments')
      < deleteBody.indexOf('DELETE FROM plot_payments WHERE id = $1 RETURNING id'),
    'registry projection must be deleted before the source payment'
  );
});

test('plot mutations invalidate registry caches when a payment is deleted', () => {
  const routes = read('../src/routes/plot.routes.js');
  assert.match(routes, /invalidateCacheOnSuccess\(\['plots\|', '\/daybook', 'registries\|', 'registries-meta\|'\]\)/);
});
