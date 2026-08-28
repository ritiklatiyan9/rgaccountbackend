import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const routeSource = readFileSync(new URL('../src/routes/bankReconciliation.routes.js', import.meta.url), 'utf8');
const controllerSource = readFileSync(new URL('../src/controllers/bankDaybookReconciliation.controller.js', import.meta.url), 'utf8');
const orderSource = readFileSync(new URL('../src/services/bankDaybookOrder.service.js', import.meta.url), 'utf8');

test('Bank Day Book reconciliation uses daybook permissions and full-entry visibility', () => {
  const previewIndex = routeSource.indexOf("'/daybook/preview'");
  const chequePermissionIndex = routeSource.indexOf("router.use(requirePermission('expense_approval', 'read'))");
  assert.ok(previewIndex > 0);
  assert.ok(previewIndex < chequePermissionIndex);
  assert.match(routeSource, /'\/daybook\/preview'[\s\S]*requirePermission\('daybook', 'read'\)[\s\S]*requireAllEntryVisibility\('daybook'\)/);
  assert.match(routeSource, /'\/daybook\/apply'[\s\S]*requirePermission\('daybook', 'update'\)[\s\S]*requireAllEntryVisibility\('daybook'\)/);
});

test('confirmation reparses the same file and enforces exact data, snapshot, and revision gates', () => {
  assert.match(controllerSource, /parseStatement\(req\)/);
  assert.match(controllerSource, /STATEMENT_FILE_CHANGED/);
  assert.match(controllerSource, /candidateSnapshotHash\(candidates\) !== expectedSnapshot/);
  assert.match(controllerSource, /exactStatementCandidatePair\(row, candidate\)/);
  assert.match(controllerSource, /expectedGlobalRevision: expectedRevision/);
  assert.match(controllerSource, /INCOMPLETE_RECONCILIATION/);
  assert.match(controllerSource, /BANK_ACCOUNT_MISMATCH/);
});

test('reconciled ordering writes presentation tables only, never accounting source data', () => {
  assert.match(orderSource, /INSERT INTO daybook_entry_order/);
  assert.match(orderSource, /INSERT INTO daybook_global_order/);
  assert.doesNotMatch(orderSource, /(?:UPDATE|DELETE FROM|INSERT INTO)\s+(?:cash_flow_entries|ledger_entries|plot_payments|expenses|farmer_payments)/i);
});

