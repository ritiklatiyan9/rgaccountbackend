import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const readSource = (relativePath) => readFile(new URL(`../${relativePath}`, import.meta.url), 'utf8');

test('new registry, installment, and inventory payments have approval metadata and pending defaults', async () => {
  const migration = await readSource('src/migrations/104_approved_transaction_posting.js');

  for (const table of ['plot_registry_payments', 'plot_installment_payments', 'vendor_inventory_payments']) {
    assert.match(migration, new RegExp(`ALTER TABLE ${table}`));
  }
  assert.match(migration, /ALTER COLUMN status SET DEFAULT 'pending'/);
  assert.match(migration, /LOWER\(COALESCE\(status, 'approved'\)\) = 'approved'/);
  assert.match(migration, /NOT IN \('BOUNCED', 'RETURNED'\)/);

  const inventoryAlter = migration.slice(
    migration.indexOf('ALTER TABLE vendor_inventory_payments'),
    migration.indexOf("UPDATE vendor_inventory_payments SET status")
  );
  for (const column of ['assigned_admin_id', 'cheque_no', 'cheque_status', 'voucher_url']) {
    assert.match(inventoryAlter, new RegExp(`ADD COLUMN IF NOT EXISTS ${column}`));
  }
});

test('unified approvals cover every newly gated payment source and preserve bounced cheque amounts', async () => {
  const controller = await readSource('src/controllers/approval.controller.js');

  assert.match(controller, /plot_installment_payment: 'plot_installment_payments'/);
  assert.match(controller, /plot_registry_payment: 'plot_registry_payments'/);
  assert.match(controller, /vendor_inventory_payment: 'vendor_inventory_payments'/);
  assert.match(controller, /source === 'plot_installment_payment'[\s\S]*reconcileInstallmentPayment/);
  assert.match(controller, /Preserve the original[\s\S]*debit\/credit/);
  assert.doesNotMatch(controller, /normalizedStatus === 'BOUNCED'[\s\S]{0,200}(debit|credit)\s*=\s*0/);
});

test('pending handovers wait for receipt while a submitted expense reserves available imprest immediately', async () => {
  const controller = await readSource('src/controllers/imprest.controller.js');
  const allocationCreate = controller.slice(
    controller.indexOf('export const createAllocation'),
    controller.indexOf('export const listAllocations')
  );
  const confirmation = controller.slice(
    controller.indexOf('export const confirmReceipt'),
    controller.indexOf('export const getBalance')
  );
  const expenseCreate = controller.slice(
    controller.indexOf('export const createExpenseFromImprest'),
    controller.indexOf('export const createExpenseRequest')
  );

  assert.doesNotMatch(allocationCreate, /type:\s*'TRANSFER_OUT'/);
  assert.match(confirmation, /type:\s*'TRANSFER_OUT'/);
  assert.match(confirmation, /type:\s*fundedByGiverFloat \? 'TRANSFER_IN' : 'ALLOCATION'/);
  assert.match(expenseCreate, /status:\s*'pending'/);
  assert.doesNotMatch(expenseCreate, /createEntry\(/);
  assert.doesNotMatch(expenseCreate, /balance is unchanged until approval/i);
  assert.match(expenseCreate, /const deductedBalance = await imprestLedgerModel\.getBalance/);
  assert.match(expenseCreate, /balance:\s*deductedBalance/);
  assert.match(expenseCreate, /(?:debited|deducted|reserved)[^.]*(?:imprest|balance)|(?:imprest|balance)[^.]*(?:debited|deducted|reserved)/i);
});

test('approved imprest expense marks only its Day Book memo as internal', async () => {
  const controller = await readSource('src/controllers/imprest.controller.js');
  const approval = controller.slice(
    controller.indexOf('// 2b. Create the expense'),
    controller.indexOf("message: 'Expense request approved and deducted from imprest'")
  );
  const expenseWrite = approval.slice(
    approval.indexOf('const expense = await expenseModel.create'),
    approval.indexOf('const dayBookData')
  );
  const daybookWrite = approval.slice(approval.indexOf('const dayBookData'));

  assert.doesNotMatch(expenseWrite, /is_imprest_internal/);
  assert.match(daybookWrite, /entry_type:\s*'IMPREST'/);
  assert.match(daybookWrite, /is_imprest_internal:\s*true/);
});

test('single plot commission approval relies on its canonical ledger projection', async () => {
  const controller = await readSource('src/controllers/approval.controller.js');
  const approveEntry = controller.slice(
    controller.indexOf('export const approveEntry'),
    controller.indexOf('export const rejectEntry')
  );

  assert.doesNotMatch(approveEntry, /INSERT INTO day_book/);
  assert.doesNotMatch(approveEntry, /Auto-generate DayBook entry for new V2 commission payments/);
});

test('universal imprest posting replaces the sub-admin-only approval hook', async () => {
  const service = await readSource('src/services/imprestPosting.service.js');
  const migration = await readSource('src/migrations/125_universal_imprest_enforcement.js');

  assert.match(migration, /source_module/);
  assert.match(migration, /reference_id/);
  assert.match(migration, /ON CONFLICT/);
  assert.doesNotMatch(service, /u\.role\s*=\s*'sub_admin'/);
});

test('plot commission writes reject malformed accounting dates before they can be omitted from list rollups', async () => {
  const controller = await readSource('src/controllers/plotCommissionV2.controller.js');
  const model = await readSource('src/models/PlotCommissionV2.model.js');

  assert.match(controller, /const isValidLedgerDate/);
  assert.match(controller, /year < 1900 \|\| year > 2100/);
  assert.match(controller, /Payment date must be a valid date between 1900 and 2100/);
  assert.match(model, /financial_transaction_posts/);
  assert.match(model, /CASE WHEN pcp\.amount < 0 THEN 'credit' ELSE 'debit' END/);
});

test('the unified pending-cheque source list supports both upgraded and legacy inventory schemas', async () => {
  const controller = await readSource('src/controllers/approval.controller.js');

  assert.match(controller, /source_vendor_payment_id/);
  assert.match(controller, /information_schema\.columns/);
  assert.match(controller, /inventorySourceFilter/);
  assert.match(controller, /inventorySupportsChequeStatus/);
  assert.match(controller, /UPPER\(COALESCE\(t\.cheque_status, ''\)\) =/);
});
