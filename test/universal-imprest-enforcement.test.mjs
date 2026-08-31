import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const readSource = (relativePath) => readFile(new URL(`../${relativePath}`, import.meta.url), 'utf8');

const MIGRATION_PATH = 'src/migrations/125_universal_imprest_enforcement.js';

test('every money-out source owner participates in universal imprest enforcement', async () => {
  const migration = await readSource(MIGRATION_PATH);

  // These are the writable source owners behind every sidebar money-out flow,
  // including nested detail pages and the direct Personal Ledger path.
  for (const [table, sourceModule] of [
    ['expenses', 'expense'],
    ['farmer_payments', 'farmer_payment'],
    ['plot_commissions', 'plot_commission'],
    ['plot_commission_payments', 'plot_commission_payment'],
    ['vendor_payments', 'vendor_payment'],
    ['vendor_inventory_payments', 'vendor_inventory_payment'],
    ['firm_transactions', 'firm_transaction'],
    ['cash_flow_entries', 'cash_flow_entry'],
    ['misc_income_entries', 'misc_income_entry'],
    ['plot_payments', 'plot_payment'],
    ['day_book', 'daybook'],
  ]) {
    assert.match(
      migration,
      new RegExp(`['\"]${table}['\"][^\\n]{0,160}['\"]${sourceModule}['\"]`),
      `${table} must be mapped to the ${sourceModule} source identity`
    );
  }

  assert.match(migration, /CREATE\s+TRIGGER[\s\S]*INSERT[\s\S]*UPDATE[\s\S]*DELETE/i);
  assert.match(migration, /FOR EACH ROW/i);
});

test('derived mirrors, linked proxy rows, and imprest-internal movements are excluded', async () => {
  const migration = await readSource(MIGRATION_PATH);
  const daybookController = await readSource('src/controllers/daybook.controller.js');
  const daybookStart = migration.indexOf("ELSIF TG_TABLE_NAME = 'day_book'");
  const daybookBranch = migration.slice(
    daybookStart,
    migration.indexOf('\n        ELSE', daybookStart)
  );

  // Person-ledger rows are projections of another source and must never debit
  // the creator a second time.
  assert.match(migration, /_person/);

  // A vendor inventory payment linked to its vendor payment is the same money
  // movement. Cash-flow rows with a source identity are projections owned by
  // that source table, while only source-less cash-flow rows are direct entries.
  assert.match(migration, /source_vendor_payment_id/);
  assert.match(migration, /source_module/);
  assert.match(migration, /IS\s+(?:NOT\s+)?NULL/i);

  // Day Book rows used to move imprest itself are internal transfers, not a
  // second expense by the user recording that transfer.
  assert.match(migration, /entry_type/i);
  assert.match(migration, /['\"]IMPREST['\"]/);

  // Editable labels alone never grant a runtime exclusion. A durable
  // server-authored projection marker survives legacy ON DELETE SET NULL FKs.
  assert.match(migration, /ADD COLUMN IF NOT EXISTS is_imprest_internal BOOLEAN NOT NULL DEFAULT FALSE/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS is_financial_projection BOOLEAN NOT NULL DEFAULT FALSE/);
  assert.match(migration, /CREATE OR REPLACE FUNCTION preserve_daybook_financial_projection/);
  assert.match(migration, /OLD\.is_financial_projection/);
  assert.match(migration, /IF TG_OP = 'INSERT' THEN[\s\S]*NEW\.is_financial_projection :=[\s\S]*NEW\.vendor_payment_id IS NOT NULL/);
  assert.doesNotMatch(
    migration.slice(
      migration.indexOf('CREATE OR REPLACE FUNCTION preserve_daybook_financial_projection'),
      migration.indexOf('CREATE TRIGGER trg_preserve_daybook_financial_projection')
    ),
    /COALESCE\(NEW\.is_financial_projection/
  );
  for (const foreignKey of [
    'farmer_payment_id', 'commission_id', 'cash_flow_entry_id',
    'firm_transaction_id', 'plot_payment_id', 'vendor_payment_id',
    'imprest_allocation_id',
  ]) {
    assert.match(daybookBranch, new RegExp(`v_row->>'${foreignKey}'`));
  }
  assert.match(daybookBranch, /is_financial_projection/);
  assert.match(daybookBranch, /v_entry_type = 'IMPREST'[\s\S]*is_imprest_internal/);
  assert.doesNotMatch(daybookBranch, /v_entry_type\s+IN\s*\(/);
  assert.match(migration, /125_daybook_internal_classification_v2/);
  assert.match(migration, /OVERDRAFT EXPENSE:%/);
  assert.match(daybookController, /normalizedType === 'IMPREST'[\s\S]{0,180}only be created from the Imprest module/);
  assert.match(daybookController, /normalizedEntryType === 'IMPREST'[\s\S]{0,180}only be managed from the Imprest module/);

  // Funding/transfers within imprest and receipt/registry projections are not
  // user expenses. Listing these exclusions makes double-debits fail closed.
  for (const excludedModule of [
    'imprest',
    'imprest_request',
    'document_imprest',
    'plot_registry_payment',
    'plot_installment_payment',
    'land_deal_payment',
  ]) {
    assert.match(migration, new RegExp(excludedModule));
  }
});

test('pending debits use one source-qualified reservation while posted debits use the ledger', async () => {
  const migration = await readSource(MIGRATION_PATH);
  const reservationSchema = migration.slice(
    migration.indexOf('CREATE TABLE IF NOT EXISTS imprest_debit_reservations'),
    migration.indexOf('CREATE OR REPLACE FUNCTION refresh_imprest_balance_snapshots')
  );
  const reconcile = migration.slice(
    migration.indexOf('CREATE OR REPLACE FUNCTION reconcile_imprest_debit'),
    migration.indexOf('CREATE OR REPLACE FUNCTION reconcile_direct_cashflow_imprest')
  );
  const sourceSync = migration.slice(
    migration.indexOf('CREATE OR REPLACE FUNCTION sync_universal_imprest_from_source'),
    migration.indexOf('const sources = [')
  );

  assert.match(reservationSchema, /CREATE TABLE IF NOT EXISTS imprest_debit_reservations/);
  assert.match(reservationSchema, /PRIMARY KEY \(source_module, reference_id\)/);
  assert.match(reservationSchema, /user_id[\s\S]*?REFERENCES users\(id\)/);
  assert.match(reservationSchema, /site_id[\s\S]*?REFERENCES sites\(id\)/);
  assert.match(reservationSchema, /CHECK \(amount > 0\)/);
  assert.match(reservationSchema, /imprest_debit_reservations\(user_id, site_id\)/);

  assert.match(reconcile, /p_posted BOOLEAN/);
  assert.match(reconcile, /v_wants_posted BOOLEAN := v_required > 0 AND COALESCE\(p_posted, FALSE\)/);
  assert.match(reconcile, /DELETE FROM imprest_debit_reservations[\s\S]*?OR v_wants_posted/);

  const pendingBranch = reconcile.indexOf('IF NOT v_wants_posted THEN');
  const reservationInsert = reconcile.indexOf('INSERT INTO imprest_debit_reservations', pendingBranch);
  const pendingReturn = reconcile.indexOf('RETURN;', reservationInsert);
  const postedLedgerInsert = reconcile.indexOf('INSERT INTO imprest_ledger', pendingReturn);
  assert.ok(pendingBranch >= 0 && reservationInsert > pendingBranch, 'pending path must insert a reservation');
  assert.ok(pendingReturn > reservationInsert, 'pending reservation path must return before ledger posting');
  assert.ok(postedLedgerInsert > pendingReturn, 'posted path must write the ledger after the reservation branch');
  assert.doesNotMatch(reconcile.slice(pendingBranch, pendingReturn), /INSERT INTO imprest_ledger/);
  assert.match(reconcile.slice(postedLedgerInsert), /['\"]EXPENSE['\"][\s\S]*?-v_required/);

  // Active determines whether money remains held. The shared posting policy
  // separately decides whether that hold is pending or an accounting posting.
  assert.match(sourceSync, /v_posted := v_active AND financial_transaction_posts/);
});

test('availability is posted balance less reservations and ledger snapshots remain posted-only', async () => {
  const model = await readSource('src/models/Imprest.model.js');
  const balanceState = model.slice(
    model.indexOf('async getBalanceState'),
    model.indexOf('async getBalance(', model.indexOf('async getBalanceState'))
  );
  const availableBalance = model.slice(
    model.indexOf('async getBalance(', model.indexOf('async getBalanceState')),
    model.indexOf('async getPostedBalance')
  );
  const postedBalance = model.slice(
    model.indexOf('async getPostedBalance'),
    model.indexOf('async findByUserId')
  );
  const createEntry = model.slice(
    model.indexOf('async createEntry'),
    model.indexOf('async findBySiteAndDate')
  );
  const allBalances = model.slice(
    model.indexOf('async getAllBalances'),
    model.indexOf('// ── Imprest Transfer Model')
  );

  assert.match(balanceState, /SELECT SUM\(il\.amount\)[\s\S]*?FROM imprest_ledger il/);
  assert.match(balanceState, /SELECT SUM\(r\.amount\)[\s\S]*?FROM imprest_debit_reservations r/);
  assert.match(balanceState, /posted_balance:\s*postedBalance/);
  assert.match(balanceState, /reserved_amount:\s*reservedAmount/);
  assert.match(balanceState, /available_balance:\s*postedBalance - reservedAmount/);
  assert.match(availableBalance, /return state\.available_balance/);
  assert.match(postedBalance, /return state\.posted_balance/);

  assert.match(createEntry, /await this\.getPostedBalance\(data\.user_id, data\.site_id \|\| null, pool\)/);
  assert.doesNotMatch(createEntry, /await this\.getBalance\(/);
  assert.match(createEntry, /const newBalance = currentBalance \+ parseFloat\(data\.amount\)/);
  assert.match(createEntry, /balance_after:\s*newBalance/);

  assert.match(allBalances, /FROM imprest_debit_reservations/);
  assert.match(allBalances, /AS posted_balance/);
  assert.match(allBalances, /AS reserved_amount/);
  assert.match(allBalances, /posted_balance, 0\) - COALESCE\(rt\.reserved_amount, 0\)[\s\S]*?AS available_balance/);
});

test('a debit atomically locks its owner availability and rejects insufficient imprest', async () => {
  const migration = await readSource(MIGRATION_PATH);
  const errorMiddleware = await readSource('src/middlewares/error.middleware.js');

  assert.match(migration, /FROM\s+users[\s\S]{0,500}FOR\s+UPDATE/i);
  assert.match(migration, /SUM\s*\(\s*(?:il\.)?amount\s*\)/i);
  assert.match(migration, /SUM\s*\(\s*r\.amount\s*\)/i);
  assert.match(migration, /v_base := v_current - v_source_net - v_other_reserved/);
  assert.match(migration, /RAISE\s+EXCEPTION/i);
  assert.match(migration, /INSUFFICIENT_IMPREST/);
  assert.match(migration, /available/i);
  assert.match(migration, /required/i);
  assert.match(migration, /p_user_id IS NOT NULL AND v_required > 0/);

  // Once the shared posting policy says the debit is posted, it becomes a
  // negative ledger entry rather than remaining an availability reservation.
  assert.match(migration, /['\"]EXPENSE['\"]/);
  assert.match(migration, /-\s*(?:v_)?(?:amount|debit|required_amount|required)/i);

  assert.match(errorMiddleware, /imprest_sufficient_balance/);
  assert.match(errorMiddleware, /409/);
  assert.match(errorMiddleware, /INSUFFICIENT_IMPREST/);
});

test('SPLIT farmer payments charge their effective cash and bank ledger legs', async () => {
  const migration = await readSource(MIGRATION_PATH);
  const farmerController = await readSource('src/controllers/farmer.controller.js');
  const farmerPaymentService = await readSource('src/services/farmerPayment.service.js');
  const farmerBranch = migration.slice(
    migration.indexOf("ELSIF TG_TABLE_NAME = 'farmer_payments'"),
    migration.indexOf("ELSIF TG_TABLE_NAME = 'plot_commissions'")
  );

  assert.match(farmerBranch, /payment_mode[\s\S]*'SPLIT'/);
  assert.match(farmerBranch, /cash_amount/);
  assert.match(farmerBranch, /bank_amount/);
  assert.match(farmerBranch, /GREATEST[\s\S]*cash_amount[\s\S]*GREATEST[\s\S]*bank_amount/);
  assert.match(farmerController, /normalizeFarmerPaymentInput\(req\.body\)/);
  assert.match(farmerPaymentService, /const total = roundMoney\(parsedCash \+ parsedBank\)/);
  assert.match(farmerPaymentService, /amount: total/);
});

test('Day Book plot-payment debits remain canonical refunds and cannot become receipts', async () => {
  const controller = await readSource('src/controllers/daybook.controller.js');
  const createStart = controller.indexOf("if (normalizedType === 'PLOT PAYMENT')");
  const createBranch = controller.slice(
    createStart,
    controller.indexOf('// ── Standard day book entry', createStart)
  );
  const updateBranch = controller.slice(
    controller.indexOf('export const updatePlotPaymentFromDayBook'),
    controller.indexOf('export const deletePlotPaymentFromDayBook')
  );

  for (const branch of [createBranch, updateBranch]) {
    assert.match(branch, /ppAmount = ppCredit > 0 \? ppCredit : -ppDebit/);
    assert.match(branch, /Math\.max\(-ppAmount, 0\)/);
    assert.match(branch, /Math\.max\(ppAmount, 0\)/);
    assert.match(branch, /exactly one plot receipt \(credit\) or refund \(debit\)/);
    assert.doesNotMatch(branch, /parseFloat\(credit\) \|\| parseFloat\(debit\)/);
  }
});

test('inactive pending rows release reservations while inactive posted rows restore the ledger exactly once', async () => {
  const migration = await readSource(MIGRATION_PATH);
  const activeRule = migration.slice(
    migration.indexOf('CREATE OR REPLACE FUNCTION imprest_debit_is_active'),
    migration.indexOf('CREATE OR REPLACE FUNCTION reconcile_imprest_debit')
  );

  assert.match(migration, /TG_OP\s*=\s*'DELETE'/i);
  assert.match(migration, /DELETE FROM imprest_debit_reservations/);
  assert.match(migration, /['\"]ADJUSTMENT['\"]/);
  assert.match(migration, /ON\s+CONFLICT/i);
  assert.match(activeRule, /['\"]pending['\"]/i);
  assert.doesNotMatch(activeRule, /NOT\s+IN\s*\([^)]*['\"]pending['\"]/i);
  assert.match(activeRule, /NOT\s+IN\s*\([^)]*['\"]returned['\"]/i);

  for (const inactiveState of ['rejected', 'cancelled', 'deleted', 'void', 'bounced', 'returned']) {
    assert.match(migration, new RegExp(inactiveState, 'i'));
  }

  // Re-activating or changing an entry must reconcile the same source identity
  // rather than stacking duplicate deductions/restorations.
  assert.match(migration, /source_module/);
  assert.match(migration, /reference_id/);
});

test('legacy generated debits whose canonical source is already missing are restored without backfilling history', async () => {
  const migration = await readSource(MIGRATION_PATH);
  const orphanRepair = migration.slice(
    migration.indexOf('WITH owned_keys AS'),
    migration.indexOf('// The first local draft')
  );

  assert.match(orphanRepair, /FROM imprest_ledger/);
  assert.match(orphanRepair, /FROM imprest_debit_reservations/);
  for (const table of [
    'expenses', 'farmer_payments', 'plot_commissions',
    'plot_commission_payments', 'vendor_payments',
    'vendor_inventory_payments', 'firm_transactions',
    'cash_flow_entries', 'misc_income_entries', 'plot_payments', 'day_book',
  ]) {
    assert.match(orphanRepair, new RegExp(`NOT EXISTS \\(SELECT 1 FROM ${table} s`));
  }
  assert.match(orphanRepair, /source_module, reference_id, NULL, NULL, 0, FALSE, FALSE/);
  assert.match(orphanRepair, /LEGACY SOURCE MISSING/);
  assert.doesNotMatch(orphanRepair, /INSERT INTO imprest_ledger/);
});

test('the universal imprest migration is included in both production migration chains', async () => {
  const pkg = JSON.parse(await readSource('package.json'));
  const migrationCommand = `node ${MIGRATION_PATH}`;
  const entry = Object.entries(pkg.scripts).find(([, command]) => command === migrationCommand);

  assert.ok(entry, `package.json must expose a script for ${migrationCommand}`);
  const [scriptName] = entry;
  const escapedScriptName = scriptName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  assert.match(pkg.scripts.start, new RegExp(`npm run ${escapedScriptName}`));
  assert.match(pkg.scripts.migrate, new RegExp(`npm run ${escapedScriptName}`));
});
