import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const readSource = (relativePath) => readFile(new URL(`../${relativePath}`, import.meta.url), 'utf8');

test('imprest transfers keep sub-admin source ownership and update both ledgers atomically', async () => {
  const controller = await readSource('src/controllers/imprest.controller.js');

  assert.match(controller, /callerIsAdmin\s*\?\s*parseInt\(from_user_id, 10\)\s*:\s*req\.user\.id/);
  assert.match(controller, /await client\.query\('BEGIN'\)/);
  assert.match(controller, /await lockImprestAccounts\(client, fromUserId, toUserId\)/);
  assert.match(controller, /sourceBalance < transferAmount/);
  assert.match(controller, /type:\s*'TRANSFER_OUT'/);
  assert.match(controller, /type:\s*'TRANSFER_IN'/);
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
