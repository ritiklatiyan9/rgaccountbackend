import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const controller = read('../src/controllers/transactionTransfer.controller.js');
const validation = read('../src/services/transactionTransfer.validation.js');
const pairedMigration = read('../src/migrations/163_paired_transaction_transfers.js');
const upgradeMigration = read('../src/migrations/168_partner_profit_transfers.js');
const scripts = JSON.parse(read('../package.json')).scripts;

test('Partner Profit is an admin-only, debit-only destination with site-scoped partners', () => {
  assert.match(controller, /partner_profit:[\s\S]*?adminOnly: true[\s\S]*?targetOnly: true/);
  assert.match(controller, /Partner Profit payments must be Debit \/ Money Out entries/);
  assert.match(controller, /site_partner_shares[\s\S]*?land_partner_shares[\s\S]*?partner_profit_payments/);
  assert.match(controller, /Map the original bank entry to an active site bank/);
  assert.match(controller, /is_active=true FOR SHARE/);
});

test('Partner Profit insertion preserves the transfer audit, partner fields, and overall route', () => {
  const insert = controller.slice(controller.indexOf('const insertPartnerProfit'), controller.indexOf('const insertExpense'));
  assert.match(insert, /INSERT INTO partner_profit_payments/);
  assert.match(insert, /bank_reference,remarks/);
  assert.match(insert, /request_id,created_by/);
  assert.match(insert, /site-director\/profit\/overall\?partner=/);
  assert.match(validation, /partner_profit: \['bank_reference'\]/);
});

test('database invariants allow Partner Profit only on the destination side', () => {
  assert.match(pairedMigration, /partner_profit: \['partner_profit_payments','member_id',true\]/);
  assert.match(pairedMigration, /filter\(\(\[,config\]\)=>!config\[2\]\)/);
  assert.match(upgradeMigration, /TARGET_TYPES = \[\.\.\.SOURCE_TYPES, 'partner_profit'\]/);
  assert.match(upgradeMigration, /transaction_money_transfers_target_type_check/);
  assert.match(scripts.start, /migrate:partner-profit-transfers/);
  assert.match(scripts.migrate, /migrate:partner-profit-transfers/);
});
