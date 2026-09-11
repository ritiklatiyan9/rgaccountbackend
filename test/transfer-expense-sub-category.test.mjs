import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { editSource, normalizeTransferFields } from '../src/services/transactionTransfer.validation.js';

const read = (p) => readFile(new URL(`../${p}`, import.meta.url), 'utf8');
const readUi = (p) => readFile(new URL(`../../rgaccount/${p}`, import.meta.url), 'utf8');

const source = {
  date: '2026-09-11', amount: 100, direction: 'debit', particular: 'PARTY',
  payment_mode: 'CASH', mode: 'cash', cheque_no: null, cheque_status: null,
  status: 'approved', approved_by: 2, approved_at: '2026-09-11', bank_account_id: null, raw: {},
};

test('a transfer into Expenses may set both category and sub-category', () => {
  const edited = editSource(source, { category: 'SITE WORK', sub_category: 'LABOUR' });
  assert.equal(edited.category, 'SITE WORK');
  assert.equal(edited.sub_category, 'LABOUR');

  const stored = normalizeTransferFields('expense', { ...edited, parent_name: 'PARTY' });
  assert.equal(stored.category, 'SITE WORK');
  assert.equal(stored.sub_category, 'LABOUR'); // expenses.sub_category exists, so it keeps its own column
});

test('a destination without a sub_category column keeps the value in the narrative', () => {
  const edited = editSource(source, { category: 'SITE WORK', sub_category: 'LABOUR' });
  // day_book has `category` but no `sub_category`; nothing the user typed may be dropped.
  const daybook = normalizeTransferFields('daybook', { ...edited });
  assert.equal(daybook.sub_category, null);
  assert.match(daybook.remarks, /SUB-CATEGORY: LABOUR/);
  assert.equal(daybook.category, 'SITE WORK');

  const farmer = normalizeTransferFields('farmer_payment', { ...edited });
  assert.equal(farmer.sub_category, null);
  assert.match(farmer.remarks, /SUB-CATEGORY: LABOUR/);
});

test('an over-long sub-category is refused before the preview, not truncated on write', () => {
  assert.throws(() => editSource(source, { sub_category: 'X'.repeat(101) }), /sub_category is too long/);
});

test('the expense destination writes sub_category and the preview reports it', async () => {
  const controller = await read('src/controllers/transactionTransfer.controller.js');
  const insert = controller.slice(controller.indexOf('INSERT INTO expenses'), controller.indexOf('RETURNING *', controller.indexOf('INSERT INTO expenses')));
  assert.match(insert, /category,sub_category,status/);
  assert.match(insert, /\$26,\$27\)/); // one more placeholder than before
  assert.match(controller, /upper\(sourceExpense\.sub_category\) \|\| null/);
  assert.match(controller, /sub_category: destination\.sub_category/); // preview
  assert.match(controller, /sub_category: row\.sub_category \|\| ''/);  // seeded from the original
});

test('the transfer modal offers the real category lists, not free text', async () => {
  const [dialog, form] = await Promise.all([
    readUi('src/components/ShiftEntriesDialog.jsx'),
    readUi('src/lib/entryTransferForm.js'),
  ]);
  assert.match(form, /sub_category: source\.sub_category \|\| ''/);
  assert.match(dialog, /api\.get\('\/expense-categories'\)/);
  assert.match(dialog, /api\.get\('\/expense-categories\/sub-categories'\)/);
  // Picking a category clears a sub-category that belonged to the previous one.
  assert.match(dialog, /setDraft\(key, \{ category: value, sub_category: '' \}\)/);
  assert.match(dialog, /item\.category === draft\.category/);
  assert.match(dialog, /sub_category: 'Sub-category'/); // preview row
});
