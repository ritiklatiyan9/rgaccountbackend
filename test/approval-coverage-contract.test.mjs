import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (p) => readFile(new URL(`../${p}`, import.meta.url), 'utf8');
const readUi = (p) => readFile(new URL(`../../rgaccount/${p}`, import.meta.url), 'utf8');

test('editing an approved firm transaction returns it to the approval queue', async () => {
  const controller = await read('src/controllers/firm.controller.js');
  const update = controller.slice(controller.indexOf('export const updateTransaction'));
  // Money fields must not stay approved after an edit; the CF mirror follows
  // via trg_sync_cfe_status_firm_transactions.
  assert.match(update, /postingFields = new Set\(\['date', 'debit', 'credit', 'payment_mode', 'cheque_no'\]\)/);
  assert.match(update, /updateData\.status = 'pending'/);
  assert.match(update, /updateData\.approved_by = null/);
  assert.match(update, /updateData\.approved_at = null/);
});

test('every approval-queue module a sub-admin can be granted is offered by the approval manager', async () => {
  const [approval, admin] = await Promise.all([
    read('src/controllers/approval.controller.js'),
    read('src/controllers/admin.controller.js'),
  ]);
  const grantable = admin.slice(admin.indexOf('const APPROVAL_MODULES = ['), admin.indexOf('];', admin.indexOf('const APPROVAL_MODULES = [')));
  // Aliased keys resolve to another grant in isModuleAllowed(), so they need no row of their own.
  const aliased = new Set(['vendor_inventory_payment', 'plot_status', 'land_deal_payment']);
  const queueModules = [...approval.slice(approval.indexOf('const ALLOWED_TABLES = {'), approval.indexOf('};', approval.indexOf('const ALLOWED_TABLES = {')))
    .matchAll(/^\s{2}(\w+):/gm)].map((m) => m[1]);

  assert.ok(queueModules.length >= 15, `expected the full queue module list, got ${queueModules.length}`);
  for (const key of queueModules) {
    if (aliased.has(key)) continue;
    assert.ok(grantable.includes(`'${key}'`), `${key} reaches the approval queue but cannot be granted`);
  }
});

test('the Misc Income entry dialog always renders its approver field', async () => {
  const page = await readUi('src/pages/MiscIncome.jsx');
  // A silent `approvers.length && …` gate made the field look absent.
  assert.doesNotMatch(page, /\{approvers\.length > 0 && \(/);
  assert.match(page, /label="Send to admin for approval" className="col-span-2"/);
  assert.match(page, /No active approver is available for this site/);
});
