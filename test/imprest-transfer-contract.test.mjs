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
