import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const transfer = read('../src/controllers/transactionTransfer.controller.js');
const approvals = read('../src/controllers/approval.controller.js');
const migration = read('../src/migrations/164_transaction_transfer_approvals.js');
const scripts = JSON.parse(read('../package.json')).scripts;

test('submission stores one approval request without invoking the posting executor', () => {
  const queue = transfer.slice(transfer.indexOf('const queueTransferApproval'), transfer.indexOf('export const transferEntry'));
  assert.match(queue, /INSERT INTO transaction_transfer_approval_requests/);
  assert.match(queue, /prepareTransfer\(db, req, true\)/);
  assert.doesNotMatch(queue, /executeTransfer\(/);
  assert.match(transfer, /if \(req\.body\.assigned_admin_id[\s\S]*?queueTransferApproval[\s\S]*?status\(queued\.existing \? 200 : 202\)/);
});

test('approval posts the reviewed pair atomically and rejection posts neither leg', () => {
  const decision = transfer.slice(transfer.indexOf('export const decideTransferApproval'), transfer.indexOf('export const handleTransferError'));
  const rejection = decision.slice(decision.indexOf("if (decision === 'reject')"), decision.indexOf('const requester'));
  assert.doesNotMatch(rejection, /executeTransfer\(/);
  assert.match(decision, /const result = await executeTransfer\(db, syntheticReq, reviewer\.id\)/);
  assert.match(decision, /SET status='approved',result=\$2/);
  assert.match(decision, /await db\.query\('COMMIT'\)/);
});

test('transfer requests are wired into notification list, counts, single and bulk decisions', () => {
  assert.match(approvals, /'transaction_transfer' AS source/);
  assert.match(approvals, /transaction_transfer: transferCount/);
  assert.match(approvals, /source === 'transaction_transfer'[\s\S]*?decision: 'approve'/);
  assert.match(approvals, /source === 'transaction_transfer'[\s\S]*?decision: 'reject'/);
  assert.match(approvals, /items\.filter\(\(entry\) => entry\.source === 'transaction_transfer'\)/);
});

test('migration protects the immutable request audit and is in normal startup', () => {
  assert.match(migration, /CREATE TABLE IF NOT EXISTS transaction_transfer_approval_requests/);
  assert.match(migration, /transaction_transfer_approval_immutable/);
  assert.match(migration, /Transfer approval history cannot be deleted/);
  assert.match(scripts.start, /migrate:transfer-approvals/);
  assert.match(scripts.migrate, /migrate:transfer-approvals/);
});
