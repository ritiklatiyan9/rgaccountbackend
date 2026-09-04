import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const readBackend = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const readFrontend = (path) => readFileSync(new URL(`../../rgaccount/${path}`, import.meta.url), 'utf8');

test('migration preserves historical mappings while making banks site-owned', () => {
  const migration = readBackend('src/migrations/140_bank_accounts_site_scope.js');

  assert.match(migration, /ADD COLUMN IF NOT EXISTS site_id INTEGER REFERENCES sites/);
  assert.match(migration, /SELECT DISTINCT site_id[\s\S]+WHERE bank_account_id = \$1/);
  assert.match(migration, /INSERT INTO bank_accounts[\s\S]+SELECT \$2, name/);
  assert.match(migration, /SET bank_account_id = \$1[\s\S]+bank_account_id = \$2 AND site_id = \$3/);
  assert.match(migration, /uq_bank_accounts_site_name[\s\S]+site_id, UPPER\(TRIM\(name\)\)/);
  assert.match(migration, /CREATE CONSTRAINT TRIGGER trg_cash_flow_bank_same_site/);
});

test('bank APIs require an authorised site and reject cross-site mappings', () => {
  const controller = readBackend('src/controllers/bank.controller.js');

  assert.match(controller, /assertSiteAccess\(pool, req\.user, req\.query\.site_id\)/);
  assert.match(controller, /WHERE ba\.site_id = \$1/);
  assert.match(controller, /INSERT INTO bank_accounts \(site_id,/);
  assert.match(controller, /SELECT id FROM bank_accounts WHERE id = \$1 AND site_id = \$2/);
  assert.match(controller, /Choose a bank account from the same site as this entry/);
  assert.match(controller, /le\.site_id = \$2/);
});

test('all frontend bank pickers use the sidebar-selected site', () => {
  const bankData = readFrontend('src/lib/bankAccounts.js');
  const bankSelect = readFrontend('src/components/BankSelect.jsx');
  const bankPage = readFrontend('src/pages/BankAccounts.jsx');
  const quickEntry = readFrontend('src/components/QuickEntry.jsx');
  const dayBook = readFrontend('src/pages/DayBook.jsx');

  assert.match(bankData, /api\.get\('\/banks', \{ params: \{ site_id: siteId \} \}\)/);
  assert.match(bankSelect, /currentSite\?\.id/);
  assert.match(bankSelect, /result\.cacheKey === cacheKey/);
  assert.match(bankPage, /api\.post\('\/banks', \{ \.\.\.form, site_id: siteId \}\)/);
  assert.doesNotMatch(bankPage, /All sites/);
  assert.match(quickEntry, /api\.get\('\/banks', \{ params: \{ site_id: siteId \} \}\)/);
  assert.match(dayBook, /api\.get\('\/banks', \{ params: \{ site_id: siteId \} \}\)/);
});

test('secondary bank workflows keep the same site boundary', () => {
  const reconciliation = readBackend('src/controllers/bankDaybookReconciliation.controller.js');
  const transfer = readBackend('src/controllers/transactionTransfer.controller.js');

  assert.match(reconciliation, /FROM bank_accounts WHERE id = \$1 AND site_id = \$2/);
  assert.match(reconciliation, /AND site_id = \$2[\s\S]+statementSuffix, siteId/);
  assert.match(transfer, /ba\.site_id = cfe\.site_id/);
});
