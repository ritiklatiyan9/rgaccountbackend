import assert from 'node:assert/strict';
import test from 'node:test';
import {
  APPROVAL_SNAPSHOT_TABLES,
  financialSnapshotFunctionSql,
  plotSnapshotFunctionSql,
} from '../src/migrations/172_approval_change_snapshots.js';

test('installs snapshots for every financial source used by the unified approval queue', () => {
  for (const table of [
    'farmer_payments', 'plot_commissions', 'plot_commission_payments',
    'cash_flow_entries', 'firm_transactions', 'plot_payments',
    'plot_installment_payments', 'expenses', 'vendor_payments',
    'vendor_inventory_payments', 'plot_registry_payments', 'land_deal_payments',
    'misc_income_entries', 'day_book',
  ]) {
    assert.ok(APPROVAL_SNAPSHOT_TABLES.includes(table), `${table} is missing`);
  }
});

test('financial snapshots preserve the first pending original and refresh the proposal', () => {
  assert.match(financialSnapshotFunctionSql, /OLD\.approval_original_data IS NOT NULL/);
  assert.match(financialSnapshotFunctionSql, /NEW\.approval_original_data := OLD\.approval_original_data/);
  assert.match(financialSnapshotFunctionSql, /NEW\.approval_proposed_data := to_jsonb\(NEW\)/);
  assert.match(financialSnapshotFunctionSql, /LOWER\(COALESCE\(NEW\.status/);
});

test('plot snapshots use approval_status while retaining the business status field', () => {
  assert.match(plotSnapshotFunctionSql, /NEW\.approval_status/);
  assert.doesNotMatch(plotSnapshotFunctionSql, /'updated_at', 'status'/);
});
