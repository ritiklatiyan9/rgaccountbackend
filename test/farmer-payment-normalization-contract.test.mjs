import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

import {
  FARMER_PAYMENT_DAYBOOK_MODES,
  FARMER_PAYMENT_MODES,
  FarmerPaymentValidationError,
  canonicalFarmerPaymentModeFromDayBook,
  farmerPaymentFieldsTouched,
  normalizeFarmerPaymentInput,
} from '../src/services/farmerPayment.service.js';

const readSource = (relativePath) => readFile(new URL(`../${relativePath}`, import.meta.url), 'utf8');

const functionSection = (source, exportName, nextExportName = null) => {
  const start = source.indexOf(`export const ${exportName}`);
  assert.notEqual(start, -1, `${exportName} must be exported`);
  const end = nextExportName
    ? source.indexOf(`export const ${nextExportName}`, start + 1)
    : source.length;
  return source.slice(start, end === -1 ? source.length : end);
};

const moduleMapSection = (source, moduleName, nextModuleName) => {
  const start = source.indexOf(`  ${moduleName}: {`);
  assert.notEqual(start, -1, `${moduleName} edit-request handler must exist`);
  const end = source.indexOf(`  ${nextModuleName}: {`, start + 1);
  assert.notEqual(end, -1, `${moduleName} handler must end before ${nextModuleName}`);
  return source.slice(start, end);
};

const expectValidationError = (input, existing = null) => {
  assert.throws(
    () => normalizeFarmerPaymentInput(input, existing),
    (error) => {
      assert.ok(error instanceof FarmerPaymentValidationError);
      assert.equal(error.statusCode, 400);
      assert.equal(error.code, 'INVALID_FARMER_PAYMENT');
      return true;
    }
  );
};

test('farmer payment normalization has one explicit set of supported modes', () => {
  assert.deepEqual([...FARMER_PAYMENT_MODES].sort(), ['BANK', 'CASH', 'CHEQUE', 'SPLIT']);

  assert.equal(farmerPaymentFieldsTouched({ remarks: 'unchanged tuple' }), false);
  for (const field of ['transaction_type', 'payment_mode', 'amount', 'cash_amount', 'bank_amount']) {
    assert.equal(farmerPaymentFieldsTouched({ [field]: 1 }), true, `${field} must trigger tuple normalization`);
  }
});

test('DayBook settlement labels map to canonical owner modes and reject unknown labels', () => {
  assert.ok(FARMER_PAYMENT_DAYBOOK_MODES.includes('RTGS'));
  assert.equal(canonicalFarmerPaymentModeFromDayBook('CASH'), 'CASH');
  assert.equal(canonicalFarmerPaymentModeFromDayBook('CHEQUE'), 'CHEQUE');
  assert.equal(canonicalFarmerPaymentModeFromDayBook('SPLIT'), 'SPLIT');
  for (const detailedMode of [
    'RTGS', 'CASH PLOT PAYMENT', 'CASH REFUND PLOT PAYMENT', 'PAY ADVANCE',
    'NEFT', 'UPI', 'BANK TRANSFER',
  ]) {
    assert.equal(canonicalFarmerPaymentModeFromDayBook(detailedMode), 'BANK');
  }
  assert.equal(canonicalFarmerPaymentModeFromDayBook('', 'CASH'), 'CASH');
  assert.throws(
    () => canonicalFarmerPaymentModeFromDayBook('UNKNOWN MODE'),
    (error) => error instanceof FarmerPaymentValidationError
  );
});

test('create normalization derives the canonical amount and legs for every payment mode', () => {
  assert.deepEqual(
    normalizeFarmerPaymentInput({
      payment_mode: ' split ',
      amount: 1,
      cash_amount: '5000.25',
      bank_amount: '3299.75',
    }),
    {
      payment_mode: 'SPLIT',
      amount: 8300,
      cash_amount: 5000.25,
      bank_amount: 3299.75,
    }
  );

  for (const [paymentMode, expected] of [
    ['CASH', { payment_mode: 'CASH', amount: 725, cash_amount: 725, bank_amount: 0 }],
    ['BANK', { payment_mode: 'BANK', amount: 725, cash_amount: 0, bank_amount: 725 }],
    ['CHEQUE', { payment_mode: 'CHEQUE', amount: 725, cash_amount: 0, bank_amount: 725 }],
  ]) {
    assert.deepEqual(
      normalizeFarmerPaymentInput({
        payment_mode: paymentMode,
        amount: '725',
        // Irrelevant client-supplied legs cannot survive canonicalization.
        cash_amount: 99999,
        bank_amount: 99999,
      }),
      expected
    );
  }
});

test('new invalid, non-finite, non-positive, and mixed-sign farmer payments are rejected', () => {
  for (const input of [
    { payment_mode: 'WIRE', amount: 100 },
    { payment_mode: 'CASH', amount: 0 },
    { payment_mode: 'BANK', amount: -1 },
    { payment_mode: 'CHEQUE', amount: Number.POSITIVE_INFINITY },
    { payment_mode: 'CASH', amount: 'not-a-number' },
    { payment_mode: 'SPLIT', cash_amount: 0, bank_amount: 0 },
    { payment_mode: 'SPLIT', cash_amount: -1, bank_amount: 100 },
    { payment_mode: 'SPLIT', cash_amount: 100, bank_amount: -1 },
    { payment_mode: 'SPLIT', cash_amount: Number.NaN, bank_amount: 100 },
  ]) {
    expectValidationError(input);
  }
});

test('only an explicit credit transaction can create a canonical negative recovery', () => {
  assert.deepEqual(
    normalizeFarmerPaymentInput({
      transaction_type: 'credit',
      payment_mode: 'CASH',
      amount: -8300,
      cash_amount: -8300,
      bank_amount: 0,
    }),
    {
      payment_mode: 'CASH',
      amount: -8300,
      cash_amount: -8300,
      bank_amount: 0,
    }
  );

  // The same signed values without an explicit recovery direction must never
  // become a back-door credit or bypass the positive-debit imprest guard.
  expectValidationError({
    payment_mode: 'CASH',
    amount: -8300,
    cash_amount: -8300,
    bank_amount: 0,
  });
});

test('partial updates merge the existing tuple before canonicalizing all four fields', () => {
  const existingSplit = {
    payment_mode: 'SPLIT',
    amount: 700,
    cash_amount: 500,
    bank_amount: 200,
  };

  assert.deepEqual(
    normalizeFarmerPaymentInput({ bank_amount: '350' }, existingSplit),
    {
      payment_mode: 'SPLIT',
      amount: 850,
      cash_amount: 500,
      bank_amount: 350,
    }
  );

  assert.deepEqual(
    normalizeFarmerPaymentInput({ payment_mode: 'CASH', amount: 900 }, existingSplit),
    {
      payment_mode: 'CASH',
      amount: 900,
      cash_amount: 900,
      bank_amount: 0,
    }
  );

  // A legacy reversal is allowed to remain when unrelated metadata is edited,
  // but touching its payment tuple must supply a new valid positive tuple.
  const legacyNegative = {
    payment_mode: 'CASH',
    amount: -8300,
    cash_amount: -8300,
    bank_amount: 0,
  };
  assert.equal(farmerPaymentFieldsTouched({ remarks: 'preserve legacy row' }), false);
  expectValidationError({ payment_mode: 'CASH' }, legacyNegative);
});

test('farmer create uses the shared normalizer and atomically creates canonical DayBook legs', async () => {
  const source = await readSource('src/controllers/farmer.controller.js');
  const createPayment = functionSection(source, 'createPayment', 'listPayments');

  assert.match(source, /from ['"]\.\.\/services\/farmerPayment\.service\.js['"]/);
  assert.match(createPayment, /normalizeFarmerPaymentInput\(req\.body/);
  assert.doesNotMatch(createPayment, /parseFloat\((?:amount|cash_amount|bank_amount)\)\s*\|\|\s*0/);

  // One data-changing statement owns the source row and both projections.
  assert.match(createPayment, /WITH\s+f\s+AS\s*\(/i);
  assert.match(createPayment, /new_payment\s+AS\s*\([\s\S]*INSERT INTO farmer_payments/i);
  assert.match(createPayment, /db_cash\s+AS\s*\([\s\S]*INSERT INTO day_book/i);
  assert.match(createPayment, /db_bank\s+AS\s*\([\s\S]*INSERT INTO day_book/i);
  assert.match(createPayment, /farmer_payment_id/);
  assert.ok(
    (createPayment.match(/WHERE\s+\$\d+::numeric\s*>\s*0/gi) || []).length >= 2,
    'a credit recovery must persist on the owner without creating debit mirror legs'
  );
});

test('nested DayBook farmer creation cannot bypass tuple normalization with a SPLIT debit', async () => {
  const source = await readSource('src/controllers/daybook.controller.js');
  const createDayBookEntry = functionSection(source, 'createDayBookEntry', 'listDayBookEntries');
  const start = createDayBookEntry.indexOf("if (normalizedType === 'FARMER PAYMENT')");
  const end = createDayBookEntry.indexOf("if (normalizedType === 'PLOT COMMISSION')", start);
  assert.ok(start >= 0 && end > start, 'the Farmer Payment DayBook branch must be isolated');
  const farmerBranch = createDayBookEntry.slice(start, end);

  assert.match(farmerBranch, /normalizeFarmerPaymentInput\(/);
  assert.match(farmerBranch, /cash_amount/);
  assert.match(farmerBranch, /bank_amount/);
  assert.doesNotMatch(farmerBranch, /const paymentAmount = parseFloat\(debit\)\s*\|\|\s*0/);

  assert.match(farmerBranch, /const client = await pool\.connect\(\)/);
  assert.match(farmerBranch, /await client\.query\(['"]BEGIN['"]\)/);
  assert.match(farmerBranch, /rebuildFarmerPaymentDayBook\([\s\S]*client/);
  assert.match(farmerBranch, /await client\.query\(['"]COMMIT['"]\)/);
  assert.match(farmerBranch, /await client\.query\(['"]ROLLBACK['"]\)/);
  assert.match(farmerBranch, /client\.release\(\)/);

  const transactionalSection = farmerBranch.slice(farmerBranch.indexOf('const client'));
  assert.doesNotMatch(transactionalSection, /farmerPaymentModel\.create\([^)]*pool/);
  assert.doesNotMatch(transactionalSection, /dayBookModel\.create\(/);
});

test('farmer update locks, merges, normalizes, and rebuilds linked DayBook rows in one transaction', async () => {
  const source = await readSource('src/controllers/farmer.controller.js');
  const updatePayment = functionSection(source, 'updatePayment', 'deletePayment');

  assert.match(updatePayment, /const client = await pool\.connect\(\)/);
  assert.match(updatePayment, /await client\.query\(['"]BEGIN['"]\)/);
  assert.match(updatePayment, /SELECT[\s\S]*FROM farmer_payments[\s\S]*FOR UPDATE/i);
  assert.match(updatePayment, /farmerPaymentFieldsTouched\(req\.body\)/);
  assert.match(updatePayment, /normalizeFarmerPaymentInput\([\s\S]*?(?:req\.body|updateData)[\s\S]*?existing/i);
  assert.match(updatePayment, /rebuildFarmerPaymentDayBook\([\s\S]*client/);
  assert.match(updatePayment, /await client\.query\(['"]COMMIT['"]\)/);
  assert.match(updatePayment, /await client\.query\(['"]ROLLBACK['"]\)/);
  assert.match(updatePayment, /client\.release\(\)/);

  const lock = updatePayment.search(/FOR UPDATE/i);
  const touchCheck = updatePayment.indexOf('farmerPaymentFieldsTouched', lock);
  const normalize = updatePayment.indexOf('normalizeFarmerPaymentInput', lock);
  const ownerUpdateCandidates = [
    updatePayment.indexOf('UPDATE farmer_payments', normalize),
    updatePayment.indexOf('farmerPaymentModel.update', normalize),
  ].filter((index) => index >= 0);
  const ownerUpdate = ownerUpdateCandidates.length ? Math.min(...ownerUpdateCandidates) : -1;
  const rebuild = updatePayment.indexOf('rebuildFarmerPaymentDayBook', ownerUpdate);
  const commit = updatePayment.search(/client\.query\(['"]COMMIT['"]\)/);
  assert.ok(lock >= 0 && lock < normalize, 'the existing tuple must be locked before normalization');
  assert.ok(touchCheck >= 0 && touchCheck < normalize, 'untouched legacy tuples must bypass normalization');
  assert.match(updatePayment.slice(touchCheck, normalize), /if\s*\([^)]*\)\s*\{/);
  assert.ok(normalize < ownerUpdate, 'the complete tuple must be normalized before the owner update');
  assert.ok(ownerUpdate < rebuild, 'DayBook mirrors must be rebuilt from the updated owner');
  assert.ok(rebuild < commit, 'owner and mirrors must share the commit boundary');

  const transactionalSection = updatePayment.slice(updatePayment.indexOf('const client'));
  assert.doesNotMatch(transactionalSection, /await pool\.query\(/);
});

test('nested DayBook farmer updates share the same lock-normalize-rebuild transaction', async () => {
  const source = await readSource('src/controllers/daybook.controller.js');
  const update = functionSection(source, 'updateFarmerPaymentFromDayBook', 'deleteFarmerPaymentFromDayBook');

  assert.match(update, /const client = await pool\.connect\(\)/);
  assert.match(update, /await client\.query\(['"]BEGIN['"]\)/);
  assert.match(update, /SELECT[\s\S]*FROM farmer_payments[\s\S]*FOR UPDATE/i);
  assert.match(update, /farmerPaymentFieldsTouched\(/);
  assert.match(update, /normalizeFarmerPaymentInput\(/);
  assert.match(update, /rebuildFarmerPaymentDayBook\([\s\S]*client/);
  assert.match(update, /await client\.query\(['"]COMMIT['"]\)/);
  assert.match(update, /await client\.query\(['"]ROLLBACK['"]\)/);
  assert.match(update, /client\.release\(\)/);

  const lock = update.search(/FOR UPDATE/i);
  const normalize = update.indexOf('normalizeFarmerPaymentInput', lock);
  const ownerUpdate = update.indexOf('UPDATE farmer_payments', normalize);
  const rebuild = update.indexOf('rebuildFarmerPaymentDayBook', ownerUpdate);
  const commit = update.search(/client\.query\(['"]COMMIT['"]\)/);
  assert.ok(lock >= 0 && lock < normalize);
  assert.ok(normalize < ownerUpdate);
  assert.ok(ownerUpdate < rebuild);
  assert.ok(rebuild < commit);
});

test('the mirror rebuilder replaces all linked rows and emits only positive canonical debit legs', async () => {
  const service = await readSource('src/services/farmerPayment.service.js');
  const start = service.indexOf('export const rebuildFarmerPaymentDayBook');
  assert.notEqual(start, -1, 'rebuildFarmerPaymentDayBook must be exported');
  const rebuild = service.slice(start);

  assert.match(rebuild, /DELETE FROM day_book[\s\S]*farmer_payment_id/i);
  assert.match(rebuild, /INSERT INTO day_book/i);
  assert.match(rebuild, /['"]CASH['"]::text AS leg_type/i);
  assert.match(rebuild, /['"]BANK['"]::text AS leg_type/i);
  assert.match(rebuild, /FARMER PAYMENT \(['"]?\s*\|\|\s*[^\n]*leg_type/i);
  assert.match(rebuild, /cash_amount/i);
  assert.match(rebuild, /bank_amount/i);
  assert.match(rebuild, />\s*0/);
  assert.match(rebuild, /farmer_payment_id/);
  assert.doesNotMatch(rebuild, /pool\.query\(/, 'the caller-owned transaction client must be used');

  const deletion = rebuild.indexOf('DELETE FROM day_book');
  const insertion = rebuild.indexOf('INSERT INTO day_book');
  assert.ok(deletion >= 0 && deletion < insertion, 'stale split legs must be removed before canonical legs are inserted');
});

test('farmer edit-request paths use the same tuple normalizer and mirror rebuild inside approval transaction', async () => {
  const source = await readSource('src/controllers/editRequest.controller.js');
  const farmerPayment = moduleMapSection(source, 'farmer_payment', 'plot');
  const daybookFarmerPayment = moduleMapSection(source, 'daybook_farmer_payment', 'daybook_commission');
  const approve = functionSection(source, 'approveEditRequest', 'rejectEditRequest');

  assert.match(source, /from ['"]\.\.\/services\/farmerPayment\.service\.js['"]/);
  for (const section of [farmerPayment, daybookFarmerPayment]) {
    assert.match(section, /farmerPaymentFieldsTouched\(/);
    assert.match(section, /normalizeFarmerPaymentInput\(/);
    assert.match(section, /if\s*\(\s*farmerPaymentFieldsTouched\([^)]*\)\s*\)\s*\{[\s\S]*?normalizeFarmerPaymentInput/);
    assert.match(section, /rebuildFarmerPaymentDayBook\([\s\S]*db/);
    assert.doesNotMatch(section, /parseFloat\((?:data\.)?(?:amount|debit|cash_amount|bank_amount)\)\s*\|\|\s*0/);
  }

  assert.match(approve, /await client\.query\(['"]BEGIN['"]\)/);
  assert.match(approve, /handler\.applyUpdate\([\s\S]*client\)/);
  assert.match(approve, /await client\.query\(['"]COMMIT['"]\)/);
  assert.match(approve, /await client\.query\(['"]ROLLBACK['"]\)/);
});
