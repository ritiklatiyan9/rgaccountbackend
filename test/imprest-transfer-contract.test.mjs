import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const readSource = (relativePath) => readFile(new URL(`../${relativePath}`, import.meta.url), 'utf8');

test('imprest transfers keep staff ledgers atomic and route Admin sides through site cash', async () => {
  const controller = await readSource('src/controllers/imprest.controller.js');

  // A sub-admin can never name a source: only an admin WITH an explicit
  // from_user_id reads the body, everyone else transfers from their own float.
  assert.match(controller, /const fromUserId = callerIsAdmin && explicitSource\s*\?\s*parseInt\(from_user_id, 10\)\s*:\s*req\.user\.id/);
  assert.match(controller, /const explicitSource = from_user_id !== undefined/);
  assert.match(controller, /await client\.query\('BEGIN'\)/);
  assert.match(controller, /const sourceIsAdmin = ADMIN_ROLES\.has\(source\.role\)/);
  assert.match(controller, /const recipientIsAdmin = ADMIN_ROLES\.has\(recipient\.role\)/);
  assert.match(controller, /await lockSiteDistribution\(client, siteId\)/);
  assert.match(controller, /sourceBalance < transferAmount/);
  assert.match(controller, /if \(!sourceIsAdmin\)[\s\S]*?type:\s*'TRANSFER_OUT'/);
  assert.match(controller, /if \(!recipientIsAdmin\)[\s\S]*?type:\s*'TRANSFER_IN'/);
  assert.match(controller, /await client\.query\('COMMIT'\)/);
  assert.match(controller, /await client\.query\('ROLLBACK'\)/);
});

test('transfer routes require site access, permissions, and eligible participants', async () => {
  const routes = await readSource('src/routes/imprest.routes.js');

  assert.match(routes, /router\.get\('\/transfers', requirePermission\('imprest', 'read'\), accessByRequiredQuerySite/);
  assert.match(routes, /router\.post\('\/transfers', requirePermission\('imprest', 'write'\), accessByRequiredBodySite, requireTransferSource, requireTransferRecipient/);
});

test('transfer migration persists audit history and permits every transfer ledger type', async () => {
  const migration = await readSource('src/migrations/099_imprest_transfers.js');

  assert.match(migration, /CREATE TABLE IF NOT EXISTS imprest_transfers/);
  assert.match(migration, /CHECK \(from_user_id <> to_user_id\)/);
  assert.match(migration, /'TRANSFER_IN', 'TRANSFER_OUT', 'TRANSFER_REFUND'/);
  assert.match(migration, /amount\s+NUMERIC\(15,2\) NOT NULL CHECK \(amount > 0\)/);
});

test('pending allocation is ledger-neutral for both parties until the recipient confirms', async () => {
  const controller = await readSource('src/controllers/imprest.controller.js');
  const createStart = controller.indexOf('export const createAllocation');
  const confirmStart = controller.indexOf('export const confirmReceipt');
  const balanceStart = controller.indexOf('export const getBalance');
  const createAllocation = controller.slice(createStart, confirmStart);
  const confirmReceipt = controller.slice(confirmStart, balanceStart);

  assert.match(createAllocation, /status:\s*'PENDING_RECEIPT'/);
  assert.doesNotMatch(createAllocation, /user_id:\s*parseInt\(sub_admin_id/);
  assert.doesNotMatch(createAllocation, /type:\s*'TRANSFER_OUT'/);
  assert.match(confirmReceipt, /existing\.sub_admin_id !== req\.user\.id/);
  assert.match(confirmReceipt, /if \(!recipientIsAdmin\)[\s\S]*?user_id:\s*req\.user\.id/);
  assert.match(confirmReceipt, /recipientIsAdmin[\s\S]*?cash returned to the Site Balance/i);
  assert.match(confirmReceipt, /type:\s*'TRANSFER_OUT'/);
  assert.match(confirmReceipt, /'This handover was already confirmed or cancelled'/);
});

test('a handover is declined only by its recipient and never after acceptance', async () => {
  const controller = await readSource('src/controllers/imprest.controller.js');
  const model = await readSource('src/models/Imprest.model.js');
  const routes = await readSource('src/routes/imprest.routes.js');
  const migration = await readSource('src/migrations/138_allocation_decline.js');

  const declineStart = controller.indexOf('export const declineReceipt');
  assert.ok(declineStart > -1, 'declineReceipt handler exists');
  const declineEnd = controller.indexOf('export const', declineStart + 1);
  const decline = controller.slice(declineStart, declineEnd === -1 ? undefined : declineEnd);

  // Recipient-only, reason required, and both refusal paths share one release.
  assert.match(decline, /existing\.sub_admin_id !== req\.user\.id/);
  assert.match(decline, /A decline reason is required/);
  assert.match(decline, /releasePendingAllocation\(/);
  const cancelStart = controller.indexOf('export const cancelAllocation');
  const cancel = controller.slice(cancelStart, controller.indexOf('releasePendingAllocation, but', cancelStart) === -1 ? controller.indexOf('async function releasePendingAllocation') : undefined);
  assert.match(cancel, /releasePendingAllocation\(/);

  // Acceptance is final: the handler names the case, and the model's WHERE
  // clause makes accept-then-decline impossible even in a race.
  assert.match(decline, /a received handover cannot be declined/);
  assert.match(model, /SET status = 'DECLINED',[\s\S]*?WHERE id = \$1 AND status = 'PENDING_RECEIPT'/);

  // Route rides on read permission like confirm — recipients may lack delete.
  assert.match(routes, /router\.put\('\/allocations\/:id\/decline', requirePermission\('imprest', 'read'\), accessByAllocation/);
  assert.match(migration, /'PENDING_RECEIPT', 'RECEIVED', 'CANCELLED', 'DECLINED'/);
});
