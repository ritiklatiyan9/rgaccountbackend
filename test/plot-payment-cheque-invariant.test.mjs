import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

const readBackend = (relativePath) => readFile(new URL(`../${relativePath}`, import.meta.url), 'utf8');
const readFrontend = (relativePath) => readFile(new URL(`../../rgaccount/${relativePath}`, import.meta.url), 'utf8');

test('plot cheque migration repairs history and enforces complete future status', async () => {
  const migration = await readBackend('src/migrations/133_plot_payment_cheque_invariant.js');

  assert.match(migration, /WHEN date < \$1::date THEN 'CLEARED'/);
  assert.match(migration, /ELSE 'PENDING'/);
  assert.match(migration, /CREATE TRIGGER trg_aa_plot_payment_cheque_invariant/);
  assert.match(migration, /plot_payments_cheque_requires_status/);
  assert.match(migration, /payment_type[\s\S]*<> 'CHEQUE'[\s\S]*cheque_status IS NOT NULL/);
});

test('plot cheque migration keeps every cash-flow mirror aligned', async () => {
  const migration = await readBackend('src/migrations/133_plot_payment_cheque_invariant.js');

  assert.match(migration, /CREATE OR REPLACE FUNCTION sync_plot_payment_cheque_mirror/);
  assert.match(migration, /SET cheque_status = NEW\.cheque_status/);
  assert.match(migration, /cheque_no = NEW\.cheque_no/);
  assert.match(migration, /source_module = 'plot_payments'/);
});

test('Day Book plot edits preserve CHEQUE and repair missing metadata', async () => {
  const controller = await readBackend('src/controllers/daybook.controller.js');
  const update = controller.slice(
    controller.indexOf('export const updatePlotPaymentFromDayBook'),
    controller.indexOf('export const deletePlotPaymentFromDayBook'),
  );

  assert.match(update, /requestedPaymentType === 'CHEQUE'/);
  assert.match(update, /cheque_no: ppPaymentType === 'CHEQUE'/);
  assert.match(update, /cheque_status: ppPaymentType === 'CHEQUE'/);
  assert.match(update, /'PENDING'/);
});

test('plot payment table renders cheque control even for a legacy null status', async () => {
  const page = await readFrontend('src/pages/PlotDetail.jsx');

  assert.match(page, /p\.payment_type === 'CHEQUE' \|\| p\.payment_from === 'CHEQUE' \|\| p\.cheque_status/);
  assert.match(page, /chequeStatus=\{p\.cheque_status \|\| 'PENDING'\}/);
});
