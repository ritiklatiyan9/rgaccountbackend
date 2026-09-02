import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

const readBackend = (relativePath) => readFile(new URL(`../${relativePath}`, import.meta.url), 'utf8');

const SUPPORTED_SOURCE_TABLES = [
  'farmer_payments',
  'plot_commission_payments',
  'firm_transactions',
  'plot_installment_payments',
  'expenses',
  'vendor_payments',
  'vendor_inventory_payments',
  'plot_registry_payments',
  'land_deal_payments',
  'misc_income_entries',
  'day_book',
];

test('all pending-cheque source modules have database invariants', async () => {
  const migration = await readBackend('src/migrations/134_pending_cheque_invariants.js');

  for (const table of SUPPORTED_SOURCE_TABLES) assert.match(migration, new RegExp(`table: '${table}'`));
  assert.match(migration, /CREATE OR REPLACE FUNCTION normalize_accounting_cheque_source/);
  assert.match(migration, /ELSE 'PENDING'/);
  assert.match(migration, /cheque_requires_status/);
  assert.match(migration, /CREATE TRIGGER trg_aa_cash_flow_cheque_invariant/);
});

test('source cheque state is automatically copied to every ledger mirror', async () => {
  const migration = await readBackend('src/migrations/134_pending_cheque_invariants.js');

  assert.match(migration, /CREATE OR REPLACE FUNCTION sync_accounting_cheque_mirror/);
  assert.match(migration, /SET cash_type = v_cash_type/);
  assert.match(migration, /cheque_status = NEW\.cheque_status/);
  assert.match(migration, /cheque_no = NEW\.cheque_no/);
  assert.match(migration, /source_module = TG_ARGV\[0\]/);
  assert.match(migration, /trg_zz_\$\{source\.table\}_cheque_mirror/);
});

test('linked registry and Day Book projections cannot become duplicate matching candidates', async () => {
  const migration = await readBackend('src/migrations/134_pending_cheque_invariants.js');
  const matching = await readBackend('src/services/chequeMatching.service.js');

  assert.match(migration, /CREATE OR REPLACE FUNCTION enforce_linked_registry_cheque_source/);
  assert.match(migration, /CREATE OR REPLACE FUNCTION sync_plot_payment_registry_cheque/);
  assert.match(migration, /source_plot_payment_id = NEW\.id/);
  assert.match(matching, /prp\.source_plot_payment_id IS NULL/);
  assert.match(matching, /db\.is_financial_projection/);
});

test('historical repair preserves the cheque policy cutoff', async () => {
  const migration = await readBackend('src/migrations/134_pending_cheque_invariants.js');

  assert.match(migration, /WHEN \$\{source\.date\} < \$1::date THEN 'CLEARED'/);
  assert.match(migration, /ELSE 'PENDING'/);
  assert.match(migration, /WHERE source_module IS NULL/);
});

test('matching and status-update services cover the same source modules', async () => {
  const matching = await readBackend('src/services/chequeMatching.service.js');
  const status = await readBackend('src/services/chequeStatus.service.js');

  for (const table of [...SUPPORTED_SOURCE_TABLES, 'plot_payments']) {
    assert.match(matching, new RegExp(`'${table}'`));
    assert.match(status, new RegExp(`table: '${table}'`));
  }
  assert.match(status, /cash_flow_entry: \{ table: 'cash_flow_entries'/);
});
