import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const readSource = (relativePath) => readFile(new URL(`../${relativePath}`, import.meta.url), 'utf8');

test('firm and optional cash-flow rows are created on one atomic database client', async () => {
  const source = await readSource('src/controllers/firm.controller.js');
  const createTransaction = source.slice(
    source.indexOf('export const createTransaction'),
    source.indexOf('export const createFirmToFirmTransfer')
  );
  const transactionalSection = createTransaction.slice(createTransaction.indexOf('const client'));

  assert.match(createTransaction, /const client = await pool\.connect\(\)/);
  assert.match(transactionalSection, /await client\.query\('BEGIN'\)/);
  assert.match(transactionalSection, /firmModel\.findById\(firmIdInt, client\)/);
  assert.match(transactionalSection, /cashFlowEntryModel\.create\([\s\S]*?\}, client\)/);
  assert.match(transactionalSection, /firmTransactionModel\.create\(data, client\)/);
  assert.doesNotMatch(transactionalSection, /await pool\.query\(/);

  const cashFlowInsert = transactionalSection.indexOf('cashFlowEntryModel.create');
  const firmInsert = transactionalSection.indexOf('firmTransactionModel.create');
  const commit = transactionalSection.indexOf("client.query('COMMIT')");
  assert.ok(cashFlowInsert < firmInsert, 'cash-flow row should be linked by the firm transaction');
  assert.ok(firmInsert < commit, 'both inserts must complete before commit');

  assert.match(transactionalSection, /catch \(error\) \{[\s\S]*?client\.query\('ROLLBACK'\)[\s\S]*?throw error/);
  assert.match(transactionalSection, /finally \{[\s\S]*?client\.release\(\)/);
});

test('firm deletes expose cash-flow deletion before releasing the canonical owner', async () => {
  const source = await readSource('src/controllers/firm.controller.js');
  const singleDelete = source.slice(
    source.indexOf('export const deleteTransaction'),
    source.indexOf('export const bulkDeleteTransactions')
  );
  const bulkDelete = source.slice(
    source.indexOf('export const bulkDeleteTransactions'),
    source.indexOf('export const getAutocomplete')
  );

  for (const section of [singleDelete, bulkDelete]) {
    assert.match(section, /const client = await pool\.connect\(\)/);
    assert.match(section, /await client\.query\('BEGIN'\)/);
    assert.match(section, /DELETE FROM cash_flow_entries/);
    assert.match(section, /DELETE FROM firm_transactions/);
    assert.match(section, /await client\.query\('COMMIT'\)/);
    assert.match(section, /await client\.query\('ROLLBACK'\)/);
    assert.match(section, /client\.release\(\)/);
    assert.doesNotMatch(section, /WITH del_cf AS/);

    const cashFlowDelete = section.indexOf('DELETE FROM cash_flow_entries');
    const firmDelete = section.indexOf('DELETE FROM firm_transactions');
    assert.ok(cashFlowDelete < firmDelete, 'cash-flow mirror must be deleted first');
  }
});
