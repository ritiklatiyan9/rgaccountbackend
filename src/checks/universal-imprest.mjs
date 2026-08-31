import assert from 'node:assert/strict';
import pool from '../config/db.js';

const USER_ID = Number.parseInt(process.env.IMPREST_CHECK_USER_ID || '5', 10);
const SITE_ID = Number.parseInt(process.env.IMPREST_CHECK_SITE_ID || '5', 10);
const FUNDING = 10000;

const postedBalance = async (db, siteId = SITE_ID, userId = USER_ID) => Number((await db.query(
  `SELECT COALESCE(SUM(amount), 0)::numeric AS balance
     FROM imprest_ledger
    WHERE user_id = $1 AND site_id = $2`,
  [userId, siteId]
)).rows[0].balance);

const reservedBalance = async (db, siteId = SITE_ID, userId = USER_ID) => Number((await db.query(
  `SELECT COALESCE(SUM(amount), 0)::numeric AS balance
     FROM imprest_debit_reservations
    WHERE user_id = $1 AND site_id = $2`,
  [userId, siteId]
)).rows[0].balance);

const balance = async (db, siteId = SITE_ID, userId = USER_ID) => (
  await postedBalance(db, siteId, userId) - await reservedBalance(db, siteId, userId)
);

const sourceNet = async (db, sourceModule, referenceId, siteId = SITE_ID, userId = USER_ID) => Number((await db.query(
  `SELECT
     COALESCE((
       SELECT SUM(amount) FROM imprest_ledger
        WHERE user_id = $1 AND site_id = $2
          AND source_module = $3 AND reference_id = $4
     ), 0)
     - COALESCE((
       SELECT SUM(amount) FROM imprest_debit_reservations
        WHERE user_id = $1 AND site_id = $2
          AND source_module = $3 AND reference_id = $4
     ), 0) AS amount`,
  [userId, siteId, sourceModule, referenceId]
)).rows[0].amount);

const sourceLedgerNet = async (db, sourceModule, referenceId, siteId = SITE_ID, userId = USER_ID) => Number((await db.query(
  `SELECT COALESCE(SUM(amount), 0)::numeric AS amount
     FROM imprest_ledger
    WHERE user_id = $1 AND site_id = $2
      AND source_module = $3 AND reference_id = $4`,
  [userId, siteId, sourceModule, referenceId]
)).rows[0].amount);

const sourceReserved = async (db, sourceModule, referenceId, siteId = SITE_ID, userId = USER_ID) => Number((await db.query(
  `SELECT COALESCE(SUM(amount), 0)::numeric AS amount
     FROM imprest_debit_reservations
    WHERE user_id = $1 AND site_id = $2
      AND source_module = $3 AND reference_id = $4`,
  [userId, siteId, sourceModule, referenceId]
)).rows[0].amount);

const verifyConcurrentGuard = async () => {
  const first = await pool.connect();
  const second = await pool.connect();
  let firstOpen = false;
  let secondOpen = false;
  let expenseId = null;
  let account = null;
  try {
    account = (await first.query(`
      WITH posted AS (
        SELECT user_id, site_id, SUM(amount)::numeric AS amount
          FROM imprest_ledger
         WHERE site_id IS NOT NULL
         GROUP BY user_id, site_id
      ), reserved AS (
        SELECT user_id, site_id, SUM(amount)::numeric AS amount
          FROM imprest_debit_reservations
         GROUP BY user_id, site_id
      )
      SELECT p.user_id, p.site_id,
             (p.amount - COALESCE(r.amount, 0))::numeric(15,2) AS available
        FROM posted p
        JOIN users u ON u.id = p.user_id AND COALESCE(u.is_active, TRUE)
        LEFT JOIN reserved r ON r.user_id = p.user_id AND r.site_id = p.site_id
       WHERE p.amount - COALESCE(r.amount, 0) >= 10
       ORDER BY CASE WHEN p.user_id = $1 THEN 0 ELSE 1 END, available
       LIMIT 1
    `, [USER_ID])).rows[0];
    assert.ok(account, 'concurrency check needs one imprest account with at least 10 available');

    const baseline = Number(account.available);
    const attemptAmount = Math.round(baseline * 0.75 * 100) / 100;

    await first.query('BEGIN');
    firstOpen = true;
    await first.query(`SELECT set_config('app.recycle_bin_skip', 'on', TRUE)`);
    expenseId = (await first.query(
      `INSERT INTO expenses
         (site_id, date, payment_mode, debit, credit, remark, status, created_by)
       VALUES ($1, CURRENT_DATE, 'CASH', $2, 0,
               'UNIVERSAL IMPREST CONCURRENT GUARD CHECK', 'pending', $3)
       RETURNING id`,
      [account.site_id, attemptAmount, account.user_id]
    )).rows[0].id;

    await second.query('BEGIN');
    secondOpen = true;
    await second.query(`SELECT set_config('app.recycle_bin_skip', 'on', TRUE)`);
    // Start the competing insert while the first transaction still owns the
    // user-row lock. Once first commits, this statement must re-read the now
    // reserved balance and fail instead of spending the same float twice.
    const competing = second.query(
      `INSERT INTO expenses
         (site_id, date, payment_mode, debit, credit, remark, status, created_by)
       VALUES ($1, CURRENT_DATE, 'CASH', $2, 0,
               'UNIVERSAL IMPREST CONCURRENT GUARD CHECK', 'pending', $3)
       RETURNING id`,
      [account.site_id, attemptAmount, account.user_id]
    ).then((result) => ({ result }), (error) => ({ error }));

    await first.query('COMMIT');
    firstOpen = false;
    const outcome = await competing;
    assert.equal(outcome.error?.constraint, 'imprest_sufficient_balance', 'the second concurrent debit must be rejected after waiting for the owner lock');
    await second.query('ROLLBACK');
    secondOpen = false;

    await first.query('BEGIN');
    firstOpen = true;
    await first.query(`SELECT set_config('app.recycle_bin_skip', 'on', TRUE)`);
    await first.query('DELETE FROM expenses WHERE id = $1', [expenseId]);
    await first.query('COMMIT');
    firstOpen = false;
    expenseId = null;

    assert.equal(
      await balance(first, Number(account.site_id), Number(account.user_id)),
      baseline,
      'concurrency check cleanup must restore the exact original availability'
    );
  } finally {
    if (secondOpen) await second.query('ROLLBACK').catch(() => {});
    if (firstOpen) await first.query('ROLLBACK').catch(() => {});
    if (expenseId && account) {
      await first.query('BEGIN').catch(() => {});
      await first.query(`SELECT set_config('app.recycle_bin_skip', 'on', TRUE)`).catch(() => {});
      await first.query('DELETE FROM expenses WHERE id = $1', [expenseId]).catch(() => {});
      await first.query('COMMIT').catch(() => {});
    }
    second.release();
    first.release();
  }
};

const client = await pool.connect();
let baseline;
try {
  const parents = (await client.query(`
    SELECT
      (SELECT id FROM farmers ORDER BY id LIMIT 1) AS farmer_id,
      (SELECT site_id FROM farmers ORDER BY id LIMIT 1) AS farmer_site_id,
      (SELECT id FROM plot_commissions_v2 ORDER BY id LIMIT 1) AS commission_v2_id,
      (SELECT site_id FROM plot_commissions_v2 ORDER BY id LIMIT 1) AS commission_site_id,
      (SELECT id FROM vendor_commitments ORDER BY id LIMIT 1) AS commitment_id,
      (SELECT site_id FROM vendor_commitments ORDER BY id LIMIT 1) AS vendor_site_id,
      (SELECT id FROM vendor_inventory_orders ORDER BY id LIMIT 1) AS inventory_order_id,
      (SELECT site_id FROM vendor_inventory_orders ORDER BY id LIMIT 1) AS inventory_site_id,
      (SELECT id FROM firms ORDER BY id LIMIT 1) AS firm_id,
      (SELECT site_id FROM firms ORDER BY id LIMIT 1) AS firm_site_id,
      (SELECT id FROM misc_income_categories ORDER BY id LIMIT 1) AS misc_category_id,
      (SELECT id FROM plots ORDER BY id LIMIT 1) AS plot_id,
      (SELECT site_id FROM plots ORDER BY id LIMIT 1) AS plot_site_id
  `)).rows[0];
  for (const key of [
    'farmer_id', 'farmer_site_id', 'commission_v2_id', 'commission_site_id',
    'commitment_id', 'vendor_site_id', 'inventory_order_id', 'inventory_site_id',
    'firm_id', 'firm_site_id', 'misc_category_id', 'plot_id', 'plot_site_id',
  ]) assert.ok(parents[key], `rollback check needs an existing ${key}`);

  const fundedSites = [...new Set([
    SITE_ID,
    Number(parents.farmer_site_id),
    Number(parents.commission_site_id),
    Number(parents.vendor_site_id),
    Number(parents.inventory_site_id),
    Number(parents.firm_site_id),
    Number(parents.plot_site_id),
  ])];
  const moveSiteId = fundedSites.find((siteId) => siteId !== SITE_ID);
  assert.ok(moveSiteId, 'rollback check needs a second site for owner/site move coverage');
  const alternateUser = (await client.query(
    `SELECT id, name, role FROM users
      WHERE id <> $1 AND COALESCE(is_active, TRUE)
      ORDER BY id LIMIT 1`,
    [USER_ID]
  )).rows[0];
  assert.ok(alternateUser?.id, 'rollback check needs a second active user for owner move coverage');
  const alternatePostedBaseline = await postedBalance(client, SITE_ID, alternateUser.id);
  const alternateReservedBaseline = await reservedBalance(client, SITE_ID, alternateUser.id);
  const baselines = new Map();
  const postedBaselines = new Map();
  const reservedBaselines = new Map();
  for (const siteId of fundedSites) {
    postedBaselines.set(siteId, await postedBalance(client, siteId));
    reservedBaselines.set(siteId, await reservedBalance(client, siteId));
    baselines.set(siteId, postedBaselines.get(siteId) - reservedBaselines.get(siteId));
  }
  baseline = baselines.get(SITE_ID);
  await client.query('BEGIN');
  await client.query(`SELECT set_config('app.recycle_bin_skip', 'on', TRUE)`);

  // Prove the guard before adding transaction-local test funds. This is the
  // exact production condition for Ravi (currently zero), and also remains a
  // valid check if the script is pointed at an account with a positive balance.
  await client.query('SAVEPOINT zero_balance_guard');
  try {
    await client.query(
      `INSERT INTO expenses
         (site_id, date, payment_mode, debit, credit, remark, status, created_by)
       VALUES ($1, CURRENT_DATE, 'CASH', $2, 0,
               'UNIVERSAL IMPREST ZERO-BALANCE CHECK', 'pending', $3)`,
      [SITE_ID, Math.max(baseline, 0) + 0.01, USER_ID]
    );
    assert.fail('a debit above the pre-funding available imprest must fail');
  } catch (error) {
    assert.equal(error.constraint, 'imprest_sufficient_balance');
    await client.query('ROLLBACK TO SAVEPOINT zero_balance_guard');
  }

  // Give each exercised account transaction-local float. The final ROLLBACK
  // removes these rows and every source/posting created below.
  for (const siteId of fundedSites) {
    await client.query(
      `INSERT INTO imprest_ledger
         (user_id, type, amount, balance_after, remarks, created_by, site_id)
       VALUES ($1, 'ADJUSTMENT', $2, $3, 'UNIVERSAL IMPREST ROLLBACK CHECK', $1, $4)`,
      [USER_ID, FUNDING, postedBaselines.get(siteId) + FUNDING, siteId]
    );
  }
  await client.query(
    `INSERT INTO imprest_ledger
       (user_id, type, amount, balance_after, remarks, created_by, site_id)
     VALUES ($1, 'ADJUSTMENT', $2, $3,
             'UNIVERSAL IMPREST OWNER-MOVE CHECK', $1, $4)`,
    [alternateUser.id, FUNDING, alternatePostedBaseline + FUNDING, SITE_ID]
  );

  const pendingDelete = (await client.query(
    `INSERT INTO expenses
       (site_id, date, payment_mode, debit, credit, remark, status, created_by)
     VALUES ($1, CURRENT_DATE, 'CASH', 200, 0,
             'UNIVERSAL IMPREST PENDING DELETE CHECK', 'pending', $2)
     RETURNING id`,
    [SITE_ID, USER_ID]
  )).rows[0];
  assert.equal(await sourceReserved(client, 'expense', pendingDelete.id), 200, 'pending debit must reserve before deletion');
  await client.query('DELETE FROM expenses WHERE id = $1', [pendingDelete.id]);
  assert.equal(await sourceNet(client, 'expense', pendingDelete.id), 0, 'deleting a pending debit must release its reservation');

  const siteMove = (await client.query(
    `INSERT INTO expenses
       (site_id, date, payment_mode, debit, credit, remark, status, created_by)
     VALUES ($1, CURRENT_DATE, 'CASH', 210, 0,
             'UNIVERSAL IMPREST SITE MOVE CHECK', 'pending', $2)
     RETURNING id`,
    [SITE_ID, USER_ID]
  )).rows[0];
  await client.query('UPDATE expenses SET site_id = $2, updated_at = NOW() WHERE id = $1', [siteMove.id, moveSiteId]);
  assert.equal(await sourceNet(client, 'expense', siteMove.id, SITE_ID), 0, 'site move must release the old account');
  assert.equal(await sourceNet(client, 'expense', siteMove.id, moveSiteId), -210, 'site move must reserve the new account exactly once');
  await client.query('DELETE FROM expenses WHERE id = $1', [siteMove.id]);
  assert.equal(await sourceNet(client, 'expense', siteMove.id, moveSiteId), 0, 'deleting a site-moved debit must release its new account');

  const ownerMove = (await client.query(
    `INSERT INTO expenses
       (site_id, date, payment_mode, debit, credit, remark, status, created_by)
     VALUES ($1, CURRENT_DATE, 'CASH', 220, 0,
             'UNIVERSAL IMPREST OWNER MOVE CHECK', 'pending', $2)
     RETURNING id`,
    [SITE_ID, USER_ID]
  )).rows[0];
  await client.query('UPDATE expenses SET created_by = $2, updated_at = NOW() WHERE id = $1', [ownerMove.id, alternateUser.id]);
  assert.equal(await sourceNet(client, 'expense', ownerMove.id), 0, 'creator move must release the old owner');
  assert.equal(
    await sourceNet(client, 'expense', ownerMove.id, SITE_ID, alternateUser.id),
    -220,
    'creator move must reserve the new owner exactly once'
  );
  await client.query('DELETE FROM expenses WHERE id = $1', [ownerMove.id]);
  assert.equal(
    await sourceNet(client, 'expense', ownerMove.id, SITE_ID, alternateUser.id),
    0,
    'deleting an owner-moved debit must release the new owner'
  );

  const expense = (await client.query(
    `INSERT INTO expenses
       (site_id, date, payment_mode, debit, credit, remark, status, created_by)
     VALUES ($1, CURRENT_DATE, 'CASH', 3000, 0,
             'UNIVERSAL IMPREST ROLLBACK CHECK', 'pending', $2)
     RETURNING id`,
    [SITE_ID, USER_ID]
  )).rows[0];

  assert.equal(await sourceNet(client, 'expense', expense.id), -3000, 'pending debit must reserve imprest');
  assert.equal(await sourceLedgerNet(client, 'expense', expense.id), 0, 'pending debit must not post to the accounting ledger');
  assert.equal(await sourceReserved(client, 'expense', expense.id), 3000, 'pending debit must create an availability reservation');
  assert.equal(await balance(client), baseline + 7000, 'pending expense must reduce available balance');

  await client.query('UPDATE expenses SET debit = 5000, updated_at = NOW() WHERE id = $1', [expense.id]);
  assert.equal(await sourceNet(client, 'expense', expense.id), -5000, 'amount edit must reconcile the exact delta');

  await client.query(`UPDATE expenses SET status = 'approved', updated_at = NOW() WHERE id = $1`, [expense.id]);
  assert.equal(await sourceReserved(client, 'expense', expense.id), 0, 'approval must consume the reservation');
  assert.equal(await sourceLedgerNet(client, 'expense', expense.id), -5000, 'approval must post the actual imprest expense');
  assert.equal(await balance(client), baseline + 5000, 'reservation-to-posting conversion must preserve available balance');
  const expenseSnapshot = (await client.query(
    `WITH ordered AS (
       SELECT id, balance_after,
              SUM(amount) OVER (ORDER BY created_at, id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS expected
         FROM imprest_ledger
        WHERE user_id = $1 AND site_id = $2
     )
     SELECT balance_after, expected FROM ordered WHERE id = (
       SELECT id FROM imprest_ledger
        WHERE user_id = $1 AND site_id = $2
          AND source_module = 'expense' AND reference_id = $3 AND type = 'EXPENSE'
     )`,
    [USER_ID, SITE_ID, expense.id]
  )).rows[0];
  assert.equal(Number(expenseSnapshot.balance_after), Number(expenseSnapshot.expected), 'posted balance_after snapshot must equal the ledger running sum');

  await client.query(`UPDATE expenses SET status = 'rejected', updated_at = NOW() WHERE id = $1`, [expense.id]);
  assert.equal(await sourceNet(client, 'expense', expense.id), 0, 'rejection must restore imprest');
  assert.equal(await balance(client), baseline + FUNDING, 'rejection must restore the full held amount');

  await client.query(`UPDATE expenses SET status = 'pending', updated_at = NOW() WHERE id = $1`, [expense.id]);
  assert.equal(await sourceNet(client, 'expense', expense.id), -5000, 'reactivation must reserve exactly once');

  await client.query(`UPDATE expenses SET status = 'returned', updated_at = NOW() WHERE id = $1`, [expense.id]);
  assert.equal(await sourceNet(client, 'expense', expense.id), 0, 'money-returned status must restore imprest');
  assert.equal(await balance(client), baseline + FUNDING, 'money-returned status must restore the full held amount');

  await client.query(`UPDATE expenses SET status = 'pending', updated_at = NOW() WHERE id = $1`, [expense.id]);
  assert.equal(await sourceNet(client, 'expense', expense.id), -5000, 'returned expense reactivation must reserve exactly once');

  await client.query(`UPDATE expenses SET status = 'approved', updated_at = NOW() WHERE id = $1`, [expense.id]);
  assert.equal(await sourceLedgerNet(client, 'expense', expense.id), -5000, 'reactivated approval must post exactly once');

  await client.query('DELETE FROM expenses WHERE id = $1', [expense.id]);
  assert.equal(await sourceNet(client, 'expense', expense.id), 0, 'delete must add the debit back');
  assert.equal(await balance(client), baseline + FUNDING, 'delete must restore available imprest');

  const chequeExpense = (await client.query(
    `INSERT INTO expenses
       (site_id, date, payment_mode, debit, credit, remark, status,
        cheque_status, cheque_no, created_by)
     VALUES ($1, CURRENT_DATE, 'CHEQUE', 700, 0,
             'UNIVERSAL IMPREST CHEQUE CHECK', 'pending',
             'PENDING', 'ROLLBACK-CHECK', $2)
     RETURNING id`,
    [SITE_ID, USER_ID]
  )).rows[0];
  assert.equal(await sourceReserved(client, 'expense', chequeExpense.id), 700, 'pending cheque must reserve imprest');
  assert.equal(await sourceLedgerNet(client, 'expense', chequeExpense.id), 0, 'pending cheque must not post');

  await client.query(`UPDATE expenses SET status = 'approved', updated_at = NOW() WHERE id = $1`, [chequeExpense.id]);
  assert.equal(await sourceReserved(client, 'expense', chequeExpense.id), 700, 'approved but uncleared cheque must remain reserved');
  assert.equal(await sourceLedgerNet(client, 'expense', chequeExpense.id), 0, 'uncleared cheque must remain unposted');

  await client.query(`UPDATE expenses SET cheque_status = 'CLEARED', updated_at = NOW() WHERE id = $1`, [chequeExpense.id]);
  assert.equal(await sourceReserved(client, 'expense', chequeExpense.id), 0, 'cleared cheque must consume its reservation');
  assert.equal(await sourceLedgerNet(client, 'expense', chequeExpense.id), -700, 'cleared cheque must post the debit');

  await client.query(`UPDATE expenses SET cheque_status = 'BOUNCED', updated_at = NOW() WHERE id = $1`, [chequeExpense.id]);
  assert.equal(await sourceNet(client, 'expense', chequeExpense.id), 0, 'bounced cheque must restore imprest');
  await client.query('DELETE FROM expenses WHERE id = $1', [chequeExpense.id]);
  assert.equal(await sourceNet(client, 'expense', chequeExpense.id), 0, 'deleting a bounced cheque must not restore twice');

  const monthId = Number((await client.query(
    'SELECT ensure_site_cashflow_month($1, CURRENT_DATE, $2) AS id',
    [SITE_ID, USER_ID]
  )).rows[0].id);
  const direct = (await client.query(
    `INSERT INTO cash_flow_entries
       (cash_flow_month_id, site_id, date, particular, debit, credit,
        cash_type, status, created_by)
     VALUES ($1, $2, CURRENT_DATE, 'UNIVERSAL IMPREST DIRECT CHECK',
             2000, 0, 'cash', 'pending', $3)
     RETURNING id`,
    [monthId, SITE_ID, USER_ID]
  )).rows[0];
  assert.equal(await sourceNet(client, 'cash_flow_entry', direct.id), -2000, 'direct Personal Ledger debit must reserve imprest');
  await client.query('DELETE FROM cash_flow_entries WHERE id = $1', [direct.id]);
  assert.equal(await sourceNet(client, 'cash_flow_entry', direct.id), 0, 'direct debit delete must restore imprest');

  const internalDaybook = (await client.query(
    `INSERT INTO day_book
       (site_id, date, particular, entry_type, debit, credit,
        payment_mode, status, created_by, is_imprest_internal)
     VALUES ($1, CURRENT_DATE, 'UNIVERSAL IMPREST INTERNAL CHECK',
             'IMPREST', 9000, 0, 'CASH', 'approved', $2, TRUE)
     RETURNING id`,
    [SITE_ID, USER_ID]
  )).rows[0];
  assert.equal(await sourceNet(client, 'daybook', internalDaybook.id), 0, 'internal IMPREST Day Book row must not double-charge');

  // Exercise every remaining canonical owner branch. Each source amount is
  // intentionally unique so a failed/doubled mapping is easy to diagnose.
  const farmer = (await client.query(
    `INSERT INTO farmer_payments
       (farmer_id, particular, amount, payment_mode, status, created_by)
     VALUES ($1, 'ROLLBACK CHECK', 110, 'CASH', 'pending', $2)
     RETURNING id`,
    [parents.farmer_id, USER_ID]
  )).rows[0];
  assert.equal(await sourceNet(client, 'farmer_payment', farmer.id, Number(parents.farmer_site_id)), -110);

  const splitFarmer = (await client.query(
    `INSERT INTO farmer_payments
       (farmer_id, particular, amount, payment_mode, cash_amount, bank_amount,
        status, created_by)
     VALUES ($1, 'ROLLBACK SPLIT CHECK', 1, 'SPLIT', 230, 240,
             'pending', $2)
     RETURNING id`,
    [parents.farmer_id, USER_ID]
  )).rows[0];
  assert.equal(
    await sourceNet(client, 'farmer_payment', splitFarmer.id, Number(parents.farmer_site_id)),
    -470,
    'SPLIT farmer payment must reserve its actual cash and bank legs, not a mismatched summary'
  );
  await client.query(
    `UPDATE farmer_payments
        SET amount = 1, cash_amount = 250, bank_amount = 260, updated_at = NOW()
      WHERE id = $1`,
    [splitFarmer.id]
  );
  assert.equal(
    await sourceNet(client, 'farmer_payment', splitFarmer.id, Number(parents.farmer_site_id)),
    -510,
    'editing SPLIT legs must reconcile the exact effective debit'
  );
  await client.query(
    `UPDATE farmer_payments
        SET amount = -50, cash_amount = -100, bank_amount = 50, updated_at = NOW()
      WHERE id = $1`,
    [splitFarmer.id]
  );
  assert.equal(
    await sourceNet(client, 'farmer_payment', splitFarmer.id, Number(parents.farmer_site_id)),
    -50,
    'a negative SPLIT leg must not cancel a real positive cash or bank outflow'
  );
  await client.query('DELETE FROM farmer_payments WHERE id = $1', [splitFarmer.id]);
  assert.equal(
    await sourceNet(client, 'farmer_payment', splitFarmer.id, Number(parents.farmer_site_id)),
    0,
    'deleting a SPLIT payment must restore all of its held money'
  );

  const legacyCommission = (await client.query(
    `INSERT INTO plot_commissions
       (site_id, date, particular, amount, status, created_by)
     VALUES ($1, CURRENT_DATE, 'ROLLBACK CHECK', 120, 'pending', $2)
     RETURNING id`,
    [parents.commission_site_id, USER_ID]
  )).rows[0];
  assert.equal(await sourceNet(client, 'plot_commission', legacyCommission.id, Number(parents.commission_site_id)), -120);

  const commissionPayment = (await client.query(
    `INSERT INTO plot_commission_payments
       (site_id, plot_commission_id, date, amount, payment_mode, status, created_by)
     VALUES ($1, $2, CURRENT_DATE, 130, 'CASH', 'pending', $3)
     RETURNING id`,
    [parents.commission_site_id, parents.commission_v2_id, USER_ID]
  )).rows[0];
  assert.equal(await sourceNet(client, 'plot_commission_payment', commissionPayment.id, Number(parents.commission_site_id)), -130);

  const vendor = (await client.query(
    `INSERT INTO vendor_payments
       (commitment_id, site_id, payment_date, amount, payment_mode, status, created_by)
     VALUES ($1, $2, CURRENT_DATE, 140, 'cash', 'pending', $3)
     RETURNING id`,
    [parents.commitment_id, parents.vendor_site_id, USER_ID]
  )).rows[0];
  assert.equal(await sourceNet(client, 'vendor_payment', vendor.id, Number(parents.vendor_site_id)), -140);

  const vendorDelete = (await client.query(
    `INSERT INTO vendor_payments
       (commitment_id, site_id, payment_date, amount, payment_mode, status, created_by)
     VALUES ($1, $2, CURRENT_DATE, 145, 'cash', 'pending', $3)
     RETURNING id`,
    [parents.commitment_id, parents.vendor_site_id, USER_ID]
  )).rows[0];
  const vendorProjection = (await client.query(
    `SELECT id, is_financial_projection
       FROM day_book
      WHERE vendor_payment_id = $1`,
    [vendorDelete.id]
  )).rows[0];
  assert.ok(vendorProjection?.id, 'vendor payment must have its Day Book projection');
  assert.equal(vendorProjection.is_financial_projection, true, 'linked Day Book row must retain durable projection provenance');
  await client.query(
    `UPDATE vendor_payments SET status = 'approved', updated_at = NOW() WHERE id = $1`,
    [vendorDelete.id]
  );
  assert.equal(
    await sourceLedgerNet(client, 'vendor_payment', vendorDelete.id, Number(parents.vendor_site_id)),
    -145,
    'approved vendor payment must post once before delete'
  );
  await client.query('DELETE FROM vendor_payments WHERE id = $1', [vendorDelete.id]);
  const orphanedProjection = (await client.query(
    `SELECT vendor_payment_id, is_financial_projection
       FROM day_book
      WHERE id = $1`,
    [vendorProjection.id]
  )).rows[0];
  assert.equal(orphanedProjection?.vendor_payment_id, null, 'legacy SET NULL relationship must be exercised');
  assert.equal(orphanedProjection?.is_financial_projection, true, 'projection provenance must survive owner deletion');
  assert.equal(
    await sourceNet(client, 'vendor_payment', vendorDelete.id, Number(parents.vendor_site_id)),
    0,
    'deleting the vendor owner must restore its imprest'
  );
  assert.equal(
    await sourceNet(client, 'daybook', vendorProjection.id, Number(parents.vendor_site_id)),
    0,
    'the surviving vendor Day Book projection must never become a second debit'
  );

  const standaloneInventory = (await client.query(
    `INSERT INTO vendor_inventory_payments
       (order_id, site_id, payment_date, amount, payment_mode, status, created_by)
     VALUES ($1, $2, CURRENT_DATE, 150, 'cash', 'pending', $3)
     RETURNING id`,
    [parents.inventory_order_id, parents.inventory_site_id, USER_ID]
  )).rows[0];
  assert.equal(await sourceNet(client, 'vendor_inventory_payment', standaloneInventory.id, Number(parents.inventory_site_id)), -150);

  const linkedInventory = (await client.query(
    `INSERT INTO vendor_inventory_payments
       (order_id, site_id, payment_date, amount, payment_mode, status,
        created_by, source_vendor_payment_id)
     VALUES ($1, $2, CURRENT_DATE, 140, 'cash', 'pending', $3, $4)
     RETURNING id`,
    [parents.inventory_order_id, parents.inventory_site_id, USER_ID, vendor.id]
  )).rows[0];
  assert.equal(await sourceNet(client, 'vendor_inventory_payment', linkedInventory.id, Number(parents.inventory_site_id)), 0, 'linked inventory allocation must not double-charge');

  const firmMonth = Number((await client.query(
    'SELECT ensure_site_cashflow_month($1, CURRENT_DATE, $2) AS id',
    [parents.firm_site_id, USER_ID]
  )).rows[0].id);
  const firmMirror = (await client.query(
    `INSERT INTO cash_flow_entries
       (cash_flow_month_id, site_id, date, particular, debit, credit,
        cash_type, status, created_by)
     VALUES ($1, $2, CURRENT_DATE, 'ROLLBACK FIRM MIRROR', 160, 0,
             'cash', 'pending', $3)
     RETURNING id`,
    [firmMonth, parents.firm_site_id, USER_ID]
  )).rows[0];
  const firm = (await client.query(
    `INSERT INTO firm_transactions
       (firm_id, site_id, date, description, debit, credit, payment_mode,
        status, created_by, cash_flow_entry_id)
     VALUES ($1, $2, CURRENT_DATE, 'ROLLBACK CHECK', 160, 0, 'cash',
             'pending', $3, $4)
     RETURNING id`,
    [parents.firm_id, parents.firm_site_id, USER_ID, firmMirror.id]
  )).rows[0];
  assert.equal(await sourceNet(client, 'cash_flow_entry', firmMirror.id, Number(parents.firm_site_id)), 0, 'firm-linked direct row must be released as a mirror');
  assert.equal(await sourceNet(client, 'firm_transaction', firm.id, Number(parents.firm_site_id)), -160);
  await client.query('DELETE FROM cash_flow_entries WHERE id = $1', [firmMirror.id]);
  await client.query('DELETE FROM firm_transactions WHERE id = $1', [firm.id]);
  assert.equal(
    await sourceNet(client, 'cash_flow_entry', firmMirror.id, Number(parents.firm_site_id)),
    0,
    'deleting a firm cash-flow mirror first must not create a direct debit'
  );
  assert.equal(
    await sourceNet(client, 'firm_transaction', firm.id, Number(parents.firm_site_id)),
    0,
    'deleting the firm owner must restore its complete imprest debit'
  );

  const misc = (await client.query(
    `INSERT INTO misc_income_entries
       (site_id, category_id, direction, date, amount, payment_mode,
        status, created_by, remarks)
     VALUES ($1, $2, 'debit', CURRENT_DATE, 170, 'CASH',
             'pending', $3, 'ROLLBACK CHECK')
     RETURNING id`,
    [SITE_ID, parents.misc_category_id, USER_ID]
  )).rows[0];
  assert.equal(await sourceNet(client, 'misc_income_entry', misc.id), -170);

  const plotRefund = (await client.query(
    `INSERT INTO plot_payments
       (plot_id, site_id, date, amount, payment_type, status, created_by, narration)
     VALUES ($1, $2, CURRENT_DATE, -180, 'CASH', 'pending', $3, 'ROLLBACK CHECK')
     RETURNING id`,
    [parents.plot_id, parents.plot_site_id, USER_ID]
  )).rows[0];
  assert.equal(await sourceNet(client, 'plot_payment', plotRefund.id, Number(parents.plot_site_id)), -180);

  const standaloneDaybook = (await client.query(
    `INSERT INTO day_book
       (site_id, date, particular, entry_type, debit, credit,
        payment_mode, status, created_by)
     VALUES ($1, CURRENT_DATE, 'ROLLBACK CHECK', 'GENERAL', 190, 0,
             'CASH', 'pending', $2)
     RETURNING id`,
    [SITE_ID, USER_ID]
  )).rows[0];
  assert.equal(await sourceNet(client, 'daybook', standaloneDaybook.id), -190);
  await client.query(
    `UPDATE day_book SET entry_type = 'FARMER PAYMENT', updated_at = NOW() WHERE id = $1`,
    [standaloneDaybook.id]
  );
  assert.equal(
    await sourceNet(client, 'daybook', standaloneDaybook.id),
    -190,
    'a standalone debit cannot bypass imprest by adopting a linked-module label'
  );
  await client.query(
    `UPDATE day_book SET entry_type = 'IMPREST', updated_at = NOW() WHERE id = $1`,
    [standaloneDaybook.id]
  );
  assert.equal(
    await sourceNet(client, 'daybook', standaloneDaybook.id),
    -190,
    'an unmarked IMPREST label cannot bypass the debit'
  );

  const spoofedProjection = (await client.query(
    `INSERT INTO day_book
       (site_id, date, particular, entry_type, debit, credit,
        payment_mode, status, created_by, is_financial_projection)
     VALUES ($1, CURRENT_DATE, 'UNIVERSAL IMPREST PROJECTION SPOOF CHECK',
             'GENERAL', 195, 0, 'CASH', 'pending', $2, TRUE)
     RETURNING id, is_financial_projection`,
    [SITE_ID, USER_ID]
  )).rows[0];
  assert.equal(spoofedProjection.is_financial_projection, false, 'a standalone insert cannot self-declare projection provenance');
  assert.equal(await sourceNet(client, 'daybook', spoofedProjection.id), -195, 'a spoofed projection flag cannot bypass imprest');
  const spoofedUpdate = (await client.query(
    `UPDATE day_book SET is_financial_projection = TRUE, updated_at = NOW()
      WHERE id = $1 RETURNING is_financial_projection`,
    [spoofedProjection.id]
  )).rows[0];
  assert.equal(spoofedUpdate.is_financial_projection, false, 'a standalone update cannot self-declare projection provenance');
  assert.equal(await sourceNet(client, 'daybook', spoofedProjection.id), -195, 'projection spoof update must remain charged');

  await client.query('SAVEPOINT insufficient_debit');
  try {
    await client.query(
      `INSERT INTO expenses
         (site_id, date, payment_mode, debit, credit, remark, status, created_by)
       VALUES ($1, CURRENT_DATE, 'CASH', $2, 0,
               'UNIVERSAL IMPREST INSUFFICIENT CHECK', 'pending', $3)`,
      [SITE_ID, FUNDING + 1, USER_ID]
    );
    assert.fail('an expense larger than available imprest must fail');
  } catch (error) {
    assert.equal(error.constraint, 'imprest_sufficient_balance');
    await client.query('ROLLBACK TO SAVEPOINT insufficient_debit');
  }

  await client.query('ROLLBACK');
  for (const siteId of fundedSites) {
    assert.equal(
      await postedBalance(client, siteId),
      postedBaselines.get(siteId),
      `rollback-only check must leave site ${siteId} posted balance untouched`
    );
    assert.equal(
      await reservedBalance(client, siteId),
      reservedBaselines.get(siteId),
      `rollback-only check must leave site ${siteId} reservations untouched`
    );
    assert.equal(
      await balance(client, siteId),
      baselines.get(siteId),
      `rollback-only check must leave site ${siteId} balance untouched`
    );
  }
  assert.equal(
    await postedBalance(client, SITE_ID, alternateUser.id),
    alternatePostedBaseline,
    'rollback-only check must leave the alternate owner posted balance untouched'
  );
  assert.equal(
    await reservedBalance(client, SITE_ID, alternateUser.id),
    alternateReservedBaseline,
    'rollback-only check must leave the alternate owner reservations untouched'
  );
  await verifyConcurrentGuard();
  console.log(JSON.stringify({
    ok: true,
    user_id: USER_ID,
    site_id: SITE_ID,
    posted_balance: postedBaselines.get(SITE_ID),
    reserved_amount: reservedBaselines.get(SITE_ID),
    available_balance: baseline,
    verified: [
      'expense_lifecycle', 'farmer_payment', 'legacy_plot_commission',
      'farmer_split_effective_amount', 'vendor_projection_owner_delete',
      'zero_balance_guard', 'cheque_reserve_clear_bounce',
      'plot_commission_payment', 'vendor_payment', 'standalone_inventory_payment',
      'linked_inventory_exclusion', 'firm_transaction_and_mirror', 'firm_delete_restore',
      'direct_cashflow', 'misc_income_refund', 'negative_plot_refund',
      'standalone_daybook', 'daybook_label_bypass', 'projection_spoof_guard', 'internal_daybook_exclusion',
      'pending_delete', 'site_move', 'creator_move', 'balance_after_snapshot',
      'insufficient_guard', 'concurrent_overspend_guard',
    ],
  }, null, 2));
} catch (error) {
  await client.query('ROLLBACK').catch(() => {});
  console.error(error);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
