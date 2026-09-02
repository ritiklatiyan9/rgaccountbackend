import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const readBackend = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const readFrontend = (path) => readFile(new URL(`../../rgaccount/${path}`, import.meta.url), 'utf8');

test('assigned sub-admin requests are listed and review routes remain ownership checked', async () => {
  const controller = await readBackend('src/controllers/imprest.controller.js');
  const model = await readBackend('src/models/Imprest.model.js');
  const routes = await readBackend('src/routes/imprest.routes.js');

  assert.match(model, /findAssignedToReviewer[\s\S]*?WHERE ier\.assigned_admin_id = \$1/);
  assert.match(controller, /scope === 'assigned'[\s\S]*?findAssignedToReviewer/);
  assert.match(controller, /canReviewImprestRequest[\s\S]*?request\?\.assigned_admin_id[\s\S]*?user\.id/);
  assert.match(controller, /findByIdForUpdate[\s\S]*?!canReviewImprestRequest/);
  assert.match(routes, /expense-requests\/:id\/approve', requireRole\('admin', 'sub_admin'\), requirePermission\('imprest', 'read'\)/);
  assert.match(routes, /expense-requests\/:id\/reject', requireRole\('admin', 'sub_admin'\), requirePermission\('imprest', 'read'\)/);
});

test('assigned staff approval transfers only from that reviewers own available float', async () => {
  const controller = await readBackend('src/controllers/imprest.controller.js');
  const start = controller.indexOf('export const approveExpenseRequest');
  const end = controller.indexOf('export const rejectExpenseRequest');
  const approval = controller.slice(start, end);

  assert.match(approval, /if \(req\.user\.role === 'sub_admin'\)/);
  assert.match(approval, /reviewerBalance = await imprestLedgerModel\.getBalance\(req\.user\.id/);
  assert.match(approval, /reviewerBalance < requestAmount/);
  assert.match(approval, /from_own_float:\s*true/);
  assert.match(approval, /user_id:\s*req\.user\.id,[\s\S]*?type:\s*'TRANSFER_OUT'/);
  assert.match(approval, /user_id:\s*request\.sub_admin_id,[\s\S]*?type:\s*'TRANSFER_IN'/);
});

test('personal receipt confirmation and refill request require read access while controllers enforce ownership', async () => {
  const routes = await readBackend('src/routes/imprest.routes.js');
  const controller = await readBackend('src/controllers/imprest.controller.js');

  assert.match(routes, /allocations\/:id\/confirm', requirePermission\('imprest', 'read'\)/);
  assert.match(routes, /post\('\/expense-requests', requirePermission\('imprest', 'read'\)/);
  assert.match(controller, /existing\.sub_admin_id !== req\.user\.id/);
  assert.match(controller, /Choose another user to review your Imprest request/);
});

test('Imprest page and notification bell expose direct assigned actions', async () => {
  const dashboard = await readFrontend('src/pages/ImprestDashboard.jsx');
  const layout = await readFrontend('src/components/Layout.jsx');

  assert.match(dashboard, /scope=assigned/);
  assert.match(dashboard, /Accept request[\s\S]*?handleReviewRequest\(item, 'approve'\)/);
  assert.match(dashboard, /CardButton icon=\{Check\} label="Confirm receipt"/);
  assert.match(layout, /handleNotifConfirmReceipt[\s\S]*?allocations\/\$\{entry\.id\}\/confirm/);
  assert.match(layout, /scope=assigned[\s\S]*?assignedImprests/);
  assert.match(layout, /const canReviewEntry = isAdmin \|\| Number\(entry\.assigned_admin_id\)/);
});
