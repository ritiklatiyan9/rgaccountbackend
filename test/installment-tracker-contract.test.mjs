import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

test('tracker and schedule APIs preserve site access and plot payment permissions', async () => {
  const [routes, controller] = await Promise.all([
    read('../src/routes/plot.routes.js'),
    read('../src/controllers/installment.controller.js'),
  ]);

  assert.match(routes, /router\.get\('\/payment-management'[\s\S]*requirePermission\('plot_payments',\s*'read'\)/);
  assert.match(routes, /router\.get\('\/:id\/installments'[\s\S]*accessByParamPlot/);
  assert.match(routes, /router\.post\('\/:id\/installments'[\s\S]*requirePermission\('plot_payments',\s*'write'\)[\s\S]*accessByParamPlot/);
  assert.match(controller, /const summaryAllocation = allocateInstallmentPayments\(installments,/);
  assert.match(controller, /if \(inst\.status === 'overdue'\) oc\+\+/);
});

test('payment notification settings are admin-only and approval-time dispatched', async () => {
  const [routes, approval] = await Promise.all([
    read('../src/routes/applicationSetting.routes.js'),
    read('../src/controllers/approval.controller.js'),
  ]);

  assert.match(routes, /router\.get\('\/payment-notifications',\s*authMiddleware,\s*requireRole\('admin'\)/);
  assert.match(routes, /router\.put\('\/payment-notifications',\s*authMiddleware,\s*requireRole\('admin'\)/);
  assert.match(approval, /source === 'plot_payment'[\s\S]*notifyApprovedPlotPayment\(entry\)/);
  assert.match(approval, /table === 'plot_payments'[\s\S]*notifyApprovedPlotPayment\(row\)/);
});
