import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const readSource = (relativePath) => readFile(new URL(`../${relativePath}`, import.meta.url), 'utf8');

test('the legacy delete cleanup is retired in favor of an auditable restoring adjustment', async () => {
  const migration = await readSource('src/migrations/124_imprest_delete_sync.js');
  const universal = await readSource('src/migrations/125_universal_imprest_enforcement.js');

  assert.match(migration, /CREATE OR REPLACE FUNCTION delete_source_imprest_postings/);
  assert.match(migration, /DELETE FROM imprest_ledger/);
  assert.match(migration, /source_module = TG_ARGV\[0\]/);
  assert.match(migration, /reference_id = OLD\.id/);
  assert.match(migration, /type IN \('EXPENSE', 'ADJUSTMENT'\)/);

  for (const [table, sourceModule] of [
    ['expenses', 'expense'],
    ['farmer_payments', 'farmer_payment'],
    ['plot_commission_payments', 'plot_commission_payment'],
    ['vendor_payments', 'vendor_payment'],
    ['vendor_inventory_payments', 'vendor_inventory_payment'],
    ['day_book', 'daybook'],
  ]) {
    assert.match(migration, new RegExp(`\\['${table}', '${sourceModule}'\\]`));
    assert.match(
      universal,
      new RegExp(`DROP TRIGGER IF EXISTS trg_\\$\\{table\\}_delete_imprest ON \\$\\{table\\}`)
    );
  }

  assert.match(migration, /AFTER DELETE ON \$\{table\}/);
  assert.match(universal, /DELETE FROM imprest_debit_reservations/);
  assert.match(universal, /['\"]ADJUSTMENT['\"]/);
  assert.match(universal, /AUTO RESTORED/);
});

test('the delete-sync migration is included in both production migration chains', async () => {
  const pkg = JSON.parse(await readSource('package.json'));
  assert.equal(pkg.scripts['migrate:imprest-delete-sync'], 'node src/migrations/124_imprest_delete_sync.js');
  assert.match(pkg.scripts.start, /npm run migrate:imprest-delete-sync/);
  assert.match(pkg.scripts.migrate, /npm run migrate:imprest-delete-sync/);
  assert.ok(
    pkg.scripts.start.indexOf('npm run migrate:imprest-delete-sync')
      < pkg.scripts.start.indexOf('npm run migrate:universal-imprest'),
    'universal enforcement must replace the legacy trigger after migration 124 runs'
  );
});
