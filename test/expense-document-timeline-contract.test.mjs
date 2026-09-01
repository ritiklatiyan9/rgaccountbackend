import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const readFrontend = (path) => readFile(new URL(`../../rgaccount/${path}`, import.meta.url), 'utf8');
const readBackend = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('Expenses exposes the KYC-style voucher and bill scan timeline', async () => {
  const timeline = await readFrontend('src/components/ExpenseDocumentTimeline.jsx');
  const expenses = await readFrontend('src/pages/Expenses.jsx');
  const controller = await readBackend('src/controllers/expense.controller.js');

  assert.match(timeline, /Expense document timeline/);
  assert.match(timeline, /Voucher \/ Receipt/);
  assert.match(timeline, /Bill \/ Invoice/);
  assert.match(timeline, /label=\{activeDocuments\.length \? 'Scan another' : 'Scan document'\}/);
  assert.match(timeline, /source="glass"/);
  assert.match(timeline, /format="jpeg"/);
  assert.match(timeline, /onFiles\?\.\(activeStep\.key, picked\)/);
  assert.match(timeline, /onCamera\(activeStep\.key\)/);

  assert.match(expenses, /import ExpenseDocumentTimeline/);
  assert.match(expenses, /voucher_urls: \[\]/);
  assert.match(expenses, /bill_urls: \[\]/);
  assert.match(expenses, /bill_urls: form\.bill_urls/);
  assert.match(expenses, /handleSavedDocumentUpload\(v, type, files\)/);
  assert.match(expenses, /handleRemoveSavedDocument\(v, type, url\)/);
  assert.match(expenses, /Add to Timeline/);

  assert.match(controller, /voucher_url, voucher_urls, bill_url, bill_urls/);
  assert.match(controller, /\.\.\.billColumns\(bill_urls, bill_url\)/);
});
