import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const routeSource = readFileSync(new URL('../src/routes/bankReconciliation.routes.js', import.meta.url), 'utf8');
const controllerSource = readFileSync(new URL('../src/controllers/transactionReconciliation.controller.js', import.meta.url), 'utf8');
const chequeControllerSource = readFileSync(new URL('../src/controllers/bankReconciliation.controller.js', import.meta.url), 'utf8');
const migrationSource = readFileSync(new URL('../src/migrations/127_transaction_reconciliation.js', import.meta.url), 'utf8');

test('transaction workflow routes use Day Book permissions and remain separate from cheque reconciliation', () => {
  const latestIndex = routeSource.indexOf("'/transaction-uploads/latest'");
  const chequePermissionIndex = routeSource.indexOf("router.use(requirePermission('expense_approval', 'read'))");
  assert.ok(latestIndex > 0 && latestIndex < chequePermissionIndex);
  assert.match(routeSource, /'\/transaction-uploads\/latest'[\s\S]*requirePermission\('daybook', 'read'\)/);
  assert.match(routeSource, /'\/transaction-uploads'[\s\S]*requirePermission\('daybook', 'write'\)[\s\S]*upload\.single\('statement'\)/);
  assert.match(routeSource, /'\/transaction-postings\/:transactionId'[\s\S]*requirePermission\('daybook', 'write'\)/);
});

test('statement uploads are idempotent per workflow without crossing into cheque uploads', () => {
  assert.match(migrationSource, /file_hash, workflow/);
  assert.match(controllerSource, /u\.workflow = \$4/);
  assert.match(controllerSource, /WORKFLOW = 'TRANSACTION'/);
  assert.match(chequeControllerSource, /u\.workflow = 'CHEQUE'/);
});

test('posting links enforce sequential, creator, site, date, direction, and amount verification', () => {
  assert.match(controllerSource, /ORDER BY t\.row_number, t\.id[\s\S]*LIMIT 1[\s\S]*FOR UPDATE OF t/);
  assert.match(controllerSource, /ROW_NOT_ACTIVE/);
  assert.match(controllerSource, /SOURCE_CREATOR_MISMATCH/);
  assert.match(controllerSource, /SOURCE_SITE_MISMATCH/);
  assert.match(controllerSource, /SOURCE_DATE_MISMATCH/);
  assert.match(controllerSource, /SOURCE_DIRECTION_MISMATCH/);
  assert.match(controllerSource, /SOURCE_AMOUNT_MISMATCH/);
  assert.match(migrationSource, /UNIQUE \(bank_transaction_id\)/);
  assert.match(migrationSource, /UNIQUE \(organization_id, module_key, source_entry_id\)/);
});
