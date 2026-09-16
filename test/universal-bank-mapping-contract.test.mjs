import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const readBackend = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const readFrontend = (path) => readFileSync(new URL(`../../rgaccount/${path}`, import.meta.url), 'utf8');

test('bank mappings resolve transaction tables in one authorised batch', () => {
  const controller = readBackend('src/controllers/bank.controller.js');
  const routes = readBackend('src/routes/bank.routes.js');
  const client = readFrontend('src/lib/bankAccounts.js');

  assert.match(routes, /router\.post\('\/mappings', listEntryBankMappings\)/);
  assert.match(controller, /At most 2,000 entry references/);
  assert.match(controller, /jsonb_to_recordset\(\$1::jsonb\)/);
  assert.match(controller, /s\.organization_id = \$2/);
  assert.match(controller, /user_sites us WHERE us\.site_id = cfe\.site_id AND us\.user_id = \$3/);
  assert.match(client, /api\.post\('\/banks\/mappings'/);
  assert.match(client, /const grouped = new Map\(\)/);
});

test('allocation rows inherit the bank from their canonical money movement', () => {
  const controller = readBackend('src/controllers/bank.controller.js');

  assert.match(controller, /sourceKey === 'plot_registry_payments'/);
  assert.match(controller, /candidate\.source_module = 'plot_payments'/);
  assert.match(controller, /sourceKey === 'vendor_inventory_payments'/);
  assert.match(controller, /candidate\.source_module = 'vendor_payments'/);
  assert.match(controller, /WHEN requested\.source_key = 'plot_registry_payments'/);
  assert.match(controller, /WHEN requested\.source_key = 'vendor_inventory_payments'/);
  assert.match(controller, /target\.source_module, target\.source_id/);
});

test('registry creation validates and stores inline bank mappings atomically', () => {
  const registry = readBackend('src/controllers/registry.controller.js');

  assert.match(registry, /SELECT id FROM bank_accounts WHERE site_id = \$1 AND id = ANY\(\$2::int\[\]\)/);
  assert.match(registry, /Choose bank accounts from the same site as the registry/);
  assert.match(registry, /RETURNING id/);
  assert.match(registry, /SET bank_account_id = \$1, updated_at = NOW\(\)[\s\S]+source_module = 'plot_registry_payments'/);
  assert.match(registry, /Select a bank account for every non-cash manual payment/);
  assert.match(registry, /ba\.name AS bank_account_name/);
});

test('shared mode cell hides bank selection for cash and prints mapped bank names', () => {
  const cell = readFrontend('src/components/PaymentModeBankCell.jsx');
  const receipts = readFrontend('src/lib/transactionReceipt.js');
  const statements = readFrontend('src/lib/statementDocument.js');

  assert.match(cell, /classifyPaymentMode\(paymentMode\) === 'cash'/);
  assert.match(cell, /!isCash && sourceKey && canEdit/);
  assert.match(cell, /saveBankMapping\(sourceKey, sourceId, bankId\)/);
  assert.match(receipts, /getBankMappingDetails/);
  assert.match(receipts, /bank_account_name/);
  assert.match(statements, /row\.bank_account_name \|\| row\.bank_name/);
});

test('secondary transaction entry and print surfaces retain configured banks', () => {
  const vendorManagement = readFrontend('src/pages/VendorManagement.jsx');
  const vendorReceipt = readFrontend('src/pages/VendorPaymentReceiptPrint.jsx');
  const nocSheet = readFrontend('src/components/noc/NocWorkspaceSheets.jsx');
  const nocPrint = readFrontend('src/pages/PlotRegistryNocPrint.jsx');
  const reports = readBackend('src/services/reportDefinitions.js');

  assert.match(vendorManagement, /<BankSelect/);
  assert.match(vendorManagement, /setBankMapping\('vendor_payments'/);
  assert.match(vendorReceipt, /receipt\.bank_account_name/);
  assert.match(nocSheet, /sheetForm\.bank_account_id/);
  assert.match(nocPrint, /Mode \/ Bank/);
  assert.match(reports, /mappedBankName\('expenses'/);
  assert.match(reports, /mappedBankName\('firm_transactions'/);
});
