import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const readController = () => readFile(
  new URL('../src/controllers/imprest.controller.js', import.meta.url),
  'utf8'
);

test('site distributable uses the transaction-scoped KPI custody snapshot and preserves API aliases', async () => {
  const controller = await readController();
  const start = controller.indexOf('const siteDistributable');
  const end = controller.indexOf('const overrideReasonOf');
  const implementation = controller.slice(start, end);

  assert.match(implementation, /getSiteBalanceDetail\(siteId, '1900-01-01', indiaTomorrow\(\), db\)/);
  assert.doesNotMatch(implementation, /FROM imprest_allocations/);
  assert.match(implementation, /admin_imprest_reserved:\s*adminReserved/);
  assert.match(implementation, /pending_imprest_reservations:\s*pendingReservations/);
  assert.match(implementation, /pending_receipt_total:\s*pendingReservations/);
  assert.match(implementation, /distributable_balance:\s*distributableBalance/);
  assert.match(implementation, /available:\s*distributableBalance/);
});

test('approving an imprest request cannot bypass Admin Site Balance custody', async () => {
  const controller = await readController();
  const start = controller.indexOf('export const approveExpenseRequest');
  const end = controller.indexOf('export const rejectExpenseRequest');
  const approval = controller.slice(start, end);

  const imprestBranch = approval.indexOf("if (requestType === 'IMPREST')");
  const siteLock = approval.indexOf('await lockSiteDistribution(client, request.site_id)', imprestBranch);
  const snapshot = approval.indexOf('await siteDistributable(client, request.site_id)', imprestBranch);
  const accountLock = approval.indexOf('await lockImprestAccounts(client, request.sub_admin_id)', imprestBranch);

  assert.ok(imprestBranch >= 0 && siteLock > imprestBranch, 'IMPREST approval must take the site lock');
  assert.ok(snapshot > siteLock, 'custody must be calculated after taking the site lock');
  assert.ok(accountLock > snapshot, 'account lock follows the common site-to-account lock order');
  assert.match(approval, /requestAmount > distributable\.available \+ 0\.005/);
  assert.match(approval, /code:\s*'INSUFFICIENT_SITE_BALANCE'/);
  assert.match(approval, /overrideReason\.length < 5/);
  assert.match(approval, /from_own_float:\s*false/);
  assert.match(approval, /site_balance_at_allocation:\s*distributable\.available/);
  assert.match(approval, /override_reason:\s*overrideReason/);
});
