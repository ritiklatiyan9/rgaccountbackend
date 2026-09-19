import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chequeReadyForApproval } from '../src/utils/chequeWorkflow.js';
import { transactionMovesMoney } from '../src/utils/transactionPosting.js';
import { transactionMovesMoney as frontendPosts } from '../../rgaccount/src/utils/transactionPosting.js';

for (const mode of ['CHEQUE', 'check', 'BANK']) {
  for (const cheque of ['PENDING', 'CLEARED', 'BOUNCED', 'RETURNED']) {
    for (const status of ['pending', 'approved', 'rejected']) {
      test(`${mode}/${cheque}/${status}: approval eligibility and both money directions agree`, () => {
        const entry = { amount: 12500, payment_type: mode, cheque_status: cheque, status };
        assert.equal(chequeReadyForApproval(entry), cheque === 'CLEARED');
        for (const direction of ['credit', 'debit']) {
          const expected = cheque === 'CLEARED' && status === 'approved';
          assert.equal(transactionMovesMoney({direction, status, paymentMode: mode, chequeStatus: cheque}), expected);
          assert.equal(frontendPosts(entry, direction), expected);
          assert.equal(frontendPosts({...entry, amount: -12500}, direction), expected);
        }
      });
    }
  }
}

test('missing cheque status cannot expose a legacy cheque, while non-cheque approvals remain available', () => {
  for (const key of ['payment_mode', 'payment_type', 'cash_type', 'payment_from', 'by_note']) {
    assert.equal(chequeReadyForApproval({[key]: ' cheque '}), false);
  }
  assert.equal(chequeReadyForApproval({payment_type: 'CASH'}), true);
  assert.equal(chequeReadyForApproval({plot_status: 'BOOKED'}), true);
});

test('approval lists, badge counts and atomic approval writes use the same clearance gate', async () => {
  const s = await readFile(new URL('../src/controllers/approval.controller.js', import.meta.url), 'utf8');
  assert.match(s, /chequeReadySql\(tableAlias\)/);
  assert.match(s, /const ready = ` AND \$\{chequeReadySql\(alias\)\}`/);
  assert.match(s, /if \(!chequeReadyForApproval\(check.rows\[0\]\)\)/);
  assert.match(s, /WHERE id = \$1 AND \$\{chequeReadySql\(table\)\}/);
  assert.match(s, /WHERE id = ANY\(\$1::int\[\]\) AND status = 'pending' AND \$\{chequeReadySql\(table\)\}/);
});

test('plot payment list and historical statements exclude uncleared cheques', async () => {
  for (const path of ['controllers/plot.controller.js', 'models/Plot.model.js', 'services/plotPaymentHistory.service.js']) {
    const s = await readFile(new URL(`../src/${path}`, import.meta.url), 'utf8');
    assert.match(s, /AND \$\{chequeReadySql\('pp'\)\}/);
  }
});

test('backdated cheques cannot be grandfathered again on server restart', async () => {
  const s = await readFile(new URL('../src/migrations/119_grandfather_pre_policy_cheques.js', import.meta.url), 'utf8');
  assert.match(s, /SELECT 1 FROM app_schema_migrations WHERE version = '119_grandfather_pre_policy_cheques'/);
  assert.match(s, /if \(applied.rows.length\) \{\s+await client.query\('COMMIT'\);\s+return;/);
});
