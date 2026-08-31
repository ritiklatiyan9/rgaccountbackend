import asyncHandler from '../utils/asyncHandler.js';
import {
  imprestAllocationModel,
  imprestLedgerModel,
  imprestExpenseRequestModel,
  imprestReturnModel,
  imprestTransferModel,
} from '../models/Imprest.model.js';
import { dayBookModel } from '../models/DayBook.model.js';
import { expenseModel } from '../models/Expense.model.js';
import { findEligibleImprestParticipant } from '../middlewares/imprestSiteAccess.middleware.js';
import { uploadPlotDoc, getPlotDocUrl, deletePlotDoc } from '../utils/plotDocStorage.js';
import pool from '../config/db.js';
import { getSiteBalanceDetail } from '../graphql/services/kpi.service.js';

// ── Camera-proof helpers (same S3/local store as document imprest) ──
const IMPREST_PROOF_PREFIX = 'imprest';
const uploadProof = async (file) => (file
  ? uploadPlotDoc(file.buffer, file.originalname || 'imprest-proof.jpg', file.mimetype, IMPREST_PROOF_PREFIX)
  : null);
const withProofUrls = async (rows) => Promise.all((rows || []).map(async (row) => {
  const { proof_key: proofKey, ...rest } = row;
  return { ...rest, proof_url: proofKey ? await getPlotDocUrl(proofKey) : null };
}));

// Serialize every imprest ledger mutation per user. This keeps balance checks
// and balance_after snapshots correct when expenses, returns, adjustments and
// direct transfers are submitted at the same time.
const lockImprestAccounts = async (db, ...userIds) => {
  const ids = [...new Set(userIds.map(Number).filter(Number.isInteger))].sort((a, b) => a - b);
  if (ids.length === 0) return;
  await db.query(
    'SELECT id FROM users WHERE id = ANY($1::integer[]) ORDER BY id FOR UPDATE',
    [ids]
  );
};

// ══════════════════════════════════════════════════
//  IMPREST ALLOCATION (Admin)
// ══════════════════════════════════════════════════

/**
 * POST /imprest/allocations
 * Allocate imprest to another user.
 *  - Admin → Sub-admin: creates allocation + day-book credit (admin funds entering site imprest pool).
 *  - Sub-admin → Sub-admin (peer transfer): both balances remain unchanged while pending.
 *    Recipient confirmation atomically debits the giver and credits the recipient. No day-book entry is created —
 *    the money never leaves the sub-admin pool, so site-level debit/credit is unaffected.
 */
// ── Site Balance governs distribution ──────────────────────────────────────────
// Site Balance is the ADMIN's custody, but only CASH can be distributed as
// imprest. Staff floats and pending cash handovers reduce that available cash.
// Admins never have a separate personal imprest float; Super Admin observes.
const DISTRIBUTOR_ROLES = new Set(['admin']);
const ADMIN_ROLES = new Set(['admin', 'super_admin']);
const FUNDING_HINT = 'Bring cash into the site first — or accept a staff imprest return — then distribute.';
const lockSiteDistribution = (client, siteId) => client.query(`SELECT pg_advisory_xact_lock(hashtext('imprest-site-' || $1::text))`, [siteId]);
const indiaTomorrow = () => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date()).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
  return new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day) + 1))
    .toISOString().slice(0, 10);
};
/** What the Admin can hand out right now, after every custody reservation. */
const siteDistributable = async (db, siteId) => {
  // Use the caller's connection so the advisory lock, ledger snapshot and
  // reservations are all observed inside the same transaction. Stop after
  // today in the business timezone so future-dated transactions cannot fund
  // (or block) an imprest distribution prematurely.
  const detail = await getSiteBalanceDetail(siteId, '1900-01-01', indiaTomorrow(), db);
  const round2 = (v) => Math.round(v * 100) / 100;
  const pendingReservations = round2(detail.pendingImprestReservations);
  const distributableBalance = round2(detail.distributableBalance);
  return {
    site_balance: round2(detail.siteBalance),
    cash_balance: round2(detail.cashBalance),
    bank_balance: round2(detail.bankBalance),
    imprest_held: round2(detail.imprestHeld),
    // Compatibility field for older clients. Admin personal float is retired.
    admin_imprest_reserved: 0,
    pending_imprest_reservations: pendingReservations,
    distributable_balance: distributableBalance,
    // Preserve the established API aliases used by both imprest screens.
    pending_receipt_total: pendingReservations,
    available: distributableBalance,
  };
};

/** GET /imprest/site-balance?site_id=X — the pool imprest is distributed from. */
export const getSiteBalance = asyncHandler(async (req, res) => {
  const siteId = req.imprestSiteId || parseInt(req.query.site_id);
  if (!siteId) return res.status(400).json({ message: 'Site is required' });
  const numbers = await siteDistributable(pool, siteId);
  res.json({
    ...numbers,
    can_distribute: DISTRIBUTOR_ROLES.has(req.user.role),
    observer: req.user.role === 'super_admin',
    funding_hint: numbers.available <= 0 ? FUNDING_HINT : null,
  });
});

export const createAllocation = asyncHandler(async (req, res) => {
  const { sub_admin_id, amount, remark, date, site_id, assigned_admin_id } = req.body;

  const giverIsAdmin = ADMIN_ROLES.has(req.user.role);
  // Admin handovers always come from site CASH. Non-admin handovers come from
  // the giver's own float and move only when the recipient confirms receipt.
  const escrowFromGiver = !giverIsAdmin;
  const recipientRole = req.imprestParticipants?.sub_admin_id?.role;

  if (!sub_admin_id) return res.status(400).json({ message: 'Recipient is required' });
  const allocationAmount = parseFloat(amount);
  // Admins may record a zero-amount allocation (opens the account / registers the event).
  if (!Number.isFinite(allocationAmount) || allocationAmount < 0 || (!giverIsAdmin && allocationAmount <= 0)) {
    return res.status(400).json({ message: giverIsAdmin ? 'Amount must be zero or more' : 'Amount must be positive' });
  }
  if (!site_id) return res.status(400).json({ message: 'Site is required' });
  if (parseInt(sub_admin_id) === req.user.id) {
    return res.status(400).json({ message: 'Cannot send imprest to yourself' });
  }
  if (giverIsAdmin && recipientRole !== 'sub_admin') {
    return res.status(400).json({ message: 'Site cash can only be issued to a staff imprest account' });
  }
  if (!giverIsAdmin && recipientRole === 'super_admin') {
    return res.status(400).json({ message: 'Super Admin observes imprest and cannot receive a float handover' });
  }

  const parsedSiteId = req.imprestSiteId || parseInt(site_id);
  // Site-funded distribution is the Admin's call alone; the Super Admin observes.
  if (!escrowFromGiver && !DISTRIBUTOR_ROLES.has(req.user.role)) {
    return res.status(403).json({ code: 'OBSERVER_ROLE', message: 'The Site Balance is distributed by the Admin. Super Admin observes it.' });
  }
  const proofKey = await uploadProof(req.file);

  const client = await pool.connect();
  let distributable = null;
  try {
    await client.query('BEGIN');

    // Site-funded: cash is a hard ceiling. Bank balance and override remarks
    // can never be used to mint an imprest handover.
    if (!escrowFromGiver && allocationAmount > 0) {
      await lockSiteDistribution(client, parsedSiteId);
      distributable = await siteDistributable(client, parsedSiteId);
      if (allocationAmount > distributable.available + 0.005) {
        await client.query('ROLLBACK');
        if (proofKey) await deletePlotDoc(proofKey).catch(() => {});
        const shortfall = Math.round((allocationAmount - Math.max(distributable.available, 0)) * 100) / 100;
        return res.status(400).json({
          code: 'INSUFFICIENT_SITE_BALANCE',
          ...distributable,
          shortfall,
          message: distributable.available <= 0
            ? `No site cash is available to distribute. ${FUNDING_HINT}`
            : `Only ₹${distributable.available.toLocaleString('en-IN')} cash is available (₹${shortfall.toLocaleString('en-IN')} short).`,
        });
      }
    }

    // Validate the balance now for quick feedback. The same check is repeated
    // under account locks at confirmation, which is when money actually moves.
    if (escrowFromGiver) {
      await lockImprestAccounts(client, req.user.id);
      const giverBalance = await imprestLedgerModel.getBalance(req.user.id, parsedSiteId, client);
      if (giverBalance < allocationAmount) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          message: `Insufficient imprest balance. Available ₹${giverBalance}, needed ₹${allocationAmount}`,
          balance: giverBalance,
        });
      }
    }

    const allocationDate = date || new Date().toISOString().split('T')[0];
    const allocationPaymentMode = 'CASH';

    const allocation = await imprestAllocationModel.create({
      admin_id: req.user.id,
      sub_admin_id: parseInt(sub_admin_id),
      amount: allocationAmount,
      remark: remark ? remark.trim() : null,
      assigned_admin_id: assigned_admin_id ? parseInt(assigned_admin_id) : null,
      site_id: parsedSiteId,
      proof_key: proofKey,
      from_own_float: escrowFromGiver,
      site_balance_at_allocation: distributable ? distributable.available : null,
      override_reason: null,
      status: 'PENDING_RECEIPT',
    }, client);

    if (!escrowFromGiver) {
      // Admin → sub-admin: record the admin-to-site fund movement in Day Book.
      const subAdminResult = await client.query('SELECT name FROM users WHERE id = $1', [parseInt(sub_admin_id)]);
      const subAdminName = subAdminResult.rows[0]?.name || 'Sub-Admin';

      await dayBookModel.create({
        site_id: parsedSiteId,
        date: allocationDate,
        particular: `IMPREST ALLOCATION TO ${subAdminName.toUpperCase()}`,
        entry_type: 'IMPREST',
        debit: 0,
        credit: allocationAmount,
        remarks: remark ? remark.trim().toUpperCase() : 'IMPREST FUND ALLOCATION',
        payment_mode: allocationPaymentMode,
        category: 'IMPREST',
        from_entity: 'ADMIN',
        to_entity: subAdminName.toUpperCase(),
        status: 'pending',
        created_by: req.user.id,
        imprest_allocation_id: allocation.id,
        is_imprest_internal: true,
      }, client);

    }

    await client.query('COMMIT');

    res.status(201).json({
      allocation,
      message: escrowFromGiver
        ? 'Sent for acceptance. Both balances stay unchanged until the recipient accepts.'
        : 'Cash handover created. The recipient must confirm receipt.',
    });
  } catch (err) {
    await client.query('ROLLBACK');
    if (proofKey) await deletePlotDoc(proofKey).catch(() => {});
    throw err;
  } finally {
    client.release();
  }
});

/**
 * GET /imprest/allocations
 * Admin: list all allocations. Sub-admin: list allocations where they are giver or receiver.
 */
export const listAllocations = asyncHandler(async (req, res) => {
  const { site_id } = req.query;
  const parsedSiteId = req.imprestSiteId || (site_id ? parseInt(site_id) : null);
  const callerIsAdmin = ADMIN_ROLES.has(req.user.role);

  if (callerIsAdmin) {
    const allocations = await imprestAllocationModel.findAllWithDetails(parsedSiteId, pool);
    return res.json({ allocations: await withProofUrls(allocations) });
  }

  // Sub-admin: surface both directions so the Imprest page shows the peer-transfer history.
  const params = [req.user.id];
  let query = `
    SELECT ia.*,
           sa.name as sub_admin_name, sa.email as sub_admin_email,
           ad.name as admin_name, ad.role as admin_role,
           asa.name as assigned_admin_name,
           s.name as site_name
    FROM imprest_allocations ia
    LEFT JOIN users sa ON ia.sub_admin_id = sa.id
    LEFT JOIN users ad ON ia.admin_id = ad.id
    LEFT JOIN users asa ON ia.assigned_admin_id = asa.id
    LEFT JOIN sites s ON ia.site_id = s.id
    WHERE (ia.admin_id = $1 OR ia.sub_admin_id = $1)
  `;
  if (parsedSiteId) {
    query += ` AND ia.site_id = $2`;
    params.push(parsedSiteId);
  }
  query += ` ORDER BY ia.created_at DESC`;

  const { rows } = await pool.query(query, params);
  res.json({ allocations: await withProofUrls(rows) });
});

/**
 * DELETE /imprest/allocations/:id
 * Cancel a pending allocation.
 *  - Admin: can cancel any pending allocation.
 *  - Sub-admin: can cancel only their own pending-out peer transfers.
 *  - If the giver was a sub-admin, their locked funds are refunded.
 */
export const cancelAllocation = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const callerIsAdmin = req.user.role === 'admin' || req.user.role === 'super_admin';

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const existing = await imprestAllocationModel.findById(parseInt(id), client);
    if (!existing) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Allocation not found' });
    }
    if (existing.status !== 'PENDING_RECEIPT') {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'Allocation already confirmed or cancelled' });
    }

    if (!callerIsAdmin && existing.admin_id !== req.user.id) {
      await client.query('ROLLBACK');
      return res.status(403).json({ message: 'You can only cancel your own pending transfers' });
    }

    const allocation = await imprestAllocationModel.cancelAllocation(parseInt(id), client);
    if (!allocation) {
      await client.query('ROLLBACK');
      return res.status(409).json({ message: 'Allocation could not be cancelled' });
    }

    // New pending handovers never change either balance. Only legacy rows that
    // already contain an escrow debit need a compensating refund.
    const escrow = await client.query(
      `SELECT il.id, u.role
         FROM imprest_ledger il
         JOIN users u ON u.id = il.user_id
        WHERE il.user_id = $1 AND il.site_id = $2 AND il.reference_id = $3
          AND il.type = 'TRANSFER_OUT' AND il.amount < 0
        LIMIT 1`,
      [existing.admin_id, existing.site_id, allocation.id]
    );
    if (escrow.rows[0] && !ADMIN_ROLES.has(escrow.rows[0].role)) {
      await lockImprestAccounts(client, existing.admin_id);
      await imprestLedgerModel.createEntry({
        user_id: existing.admin_id,
        type: 'TRANSFER_REFUND',
        reference_id: allocation.id,
        amount: parseFloat(existing.amount),
        remarks: `Handover cancelled — funds returned to giver.`,
        created_by: req.user.id,
        site_id: existing.site_id,
      }, client);
    }

    await client.query(
      `UPDATE day_book
          SET status = 'rejected', approved_by = $2, approved_at = NOW(), updated_at = NOW()
        WHERE imprest_allocation_id = $1 AND status = 'pending'`,
      [allocation.id, req.user.id]
    );

    await client.query('COMMIT');
    res.json({ allocation, message: 'Allocation cancelled' });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

// ══════════════════════════════════════════════════
//  IMPREST RECEIPT (Sub-Admin)
// ══════════════════════════════════════════════════

/**
 * GET /imprest/pending-receipts
 * Sub-admin: get pending allocations to confirm
 */
export const getPendingReceipts = asyncHandler(async (req, res) => {
  const { site_id } = req.query;
  const parsedSiteId = req.imprestSiteId || (site_id ? parseInt(site_id) : null);
  const allocations = await imprestAllocationModel.findPendingBySubAdminId(req.user.id, parsedSiteId, pool);
  res.json({ allocations: await withProofUrls(allocations) });
});

/**
 * PUT /imprest/allocations/:id/confirm
 * Sub-admin confirms receipt of imprest
 */
export const confirmReceipt = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { confirmation_remark } = req.body;

  if (req.user.role === 'super_admin') {
    return res.status(403).json({ code: 'OBSERVER_ROLE', message: 'Super Admin observes imprest and cannot receive float' });
  }

  if (!confirmation_remark || !confirmation_remark.trim()) {
    return res.status(400).json({ message: 'Confirmation remark is required' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Verify allocation belongs to this sub-admin
    const existing = await imprestAllocationModel.findById(parseInt(id), client);
    if (!existing) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Allocation not found' });
    }
    if (existing.sub_admin_id !== req.user.id) {
      await client.query('ROLLBACK');
      return res.status(403).json({ message: 'This allocation is not assigned to you' });
    }
    if (existing.status !== 'PENDING_RECEIPT') {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'Allocation already confirmed or cancelled' });
    }

    const giverResult = await client.query('SELECT name, role FROM users WHERE id = $1', [existing.admin_id]);
    const giverName = giverResult.rows[0]?.name || 'Giver';
    // Only staff can own a personal float. Legacy Admin rows may still carry
    // from_own_float=true, but must never debit the retired Admin ledger again.
    const fundedByGiverFloat = giverResult.rows[0]?.role === 'sub_admin';
    const recipientIsAdmin = ADMIN_ROLES.has(req.user.role);

    if (fundedByGiverFloat) {
      await lockImprestAccounts(client, existing.admin_id, req.user.id);
      const legacyEscrow = await client.query(
        `SELECT id FROM imprest_ledger
          WHERE user_id = $1 AND site_id = $2 AND reference_id = $3
            AND type = 'TRANSFER_OUT' AND amount < 0
          LIMIT 1`,
        [existing.admin_id, existing.site_id, existing.id]
      );
      if (!legacyEscrow.rows[0]) {
        const giverBalance = await imprestLedgerModel.getBalance(existing.admin_id, existing.site_id, client);
        const amount = parseFloat(existing.amount);
        if (giverBalance < amount) {
          await client.query('ROLLBACK');
          return res.status(409).json({
            message: `The giver no longer has enough imprest. Available ₹${giverBalance}, needed ₹${amount}`,
            balance: giverBalance,
          });
        }
        await imprestLedgerModel.createEntry({
          user_id: existing.admin_id,
          type: 'TRANSFER_OUT',
          reference_id: existing.id,
          amount: -amount,
          remarks: `Imprest accepted by recipient. ${confirmation_remark.trim()}`,
          created_by: req.user.id,
          site_id: existing.site_id,
        }, client);
      }
    } else {
      await lockImprestAccounts(client, req.user.id);
    }

    // 2. Confirm only after the debit can be posted successfully.
    const allocation = await imprestAllocationModel.confirmReceipt(
      parseInt(id),
      confirmation_remark.trim(),
      client
    );
    if (!allocation) {
      await client.query('ROLLBACK');
      return res.status(409).json({ message: 'This handover was already confirmed or cancelled' });
    }

    // 3. Staff recipients receive a personal float credit. An Admin recipient
    // has no personal float: debiting the staff giver automatically releases
    // the same cash back into the site's distributable custody.
    if (!recipientIsAdmin) {
      await imprestLedgerModel.createEntry({
        user_id: req.user.id,
        type: fundedByGiverFloat ? 'TRANSFER_IN' : 'ALLOCATION',
        reference_id: allocation.id,
        amount: parseFloat(allocation.amount),
        remarks: `Imprest received from ${giverName}. ${confirmation_remark.trim()}`,
        created_by: req.user.id,
        site_id: existing.site_id,
      }, client);
    }

    await client.query(
      `UPDATE day_book
          SET status = 'approved', approved_by = $2, approved_at = NOW(), updated_at = NOW()
        WHERE imprest_allocation_id = $1 AND status = 'pending'`,
      [allocation.id, req.user.id]
    );

    await client.query('COMMIT');

    const balance = recipientIsAdmin
      ? (await siteDistributable(pool, existing.site_id)).available
      : await imprestLedgerModel.getBalance(req.user.id, existing.site_id, pool);

    res.json({
      allocation,
      balance,
      message: recipientIsAdmin
        ? 'Receipt confirmed — cash returned to the Site Balance.'
        : 'Imprest receipt confirmed successfully',
    });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

// ══════════════════════════════════════════════════
//  IMPREST BALANCE & LEDGER
// ══════════════════════════════════════════════════

/**
 * GET /imprest/balance
 * Get current imprest balance for the logged-in user
 */
export const getBalance = asyncHandler(async (req, res) => {
  const userId = req.query.user_id ? parseInt(req.query.user_id) : req.user.id;

  // Admin can check any user's balance; sub-admin only their own
  if (req.user.role !== 'admin' && req.user.role !== 'super_admin' && userId !== req.user.id) {
    return res.status(403).json({ message: 'Insufficient permissions' });
  }

  const siteId = req.imprestSiteId || (req.query.site_id ? parseInt(req.query.site_id) : null);
  const target = await pool.query('SELECT role FROM users WHERE id = $1', [userId]);
  if (siteId && ADMIN_ROLES.has(target.rows[0]?.role)) {
    const cash = await siteDistributable(pool, siteId);
    const reserved = Math.max(cash.cash_balance - cash.available, 0);
    return res.json({
      balance: cash.available,
      posted_balance: cash.cash_balance,
      reserved_amount: reserved,
      available_balance: cash.available,
      user_id: userId,
      balance_source: 'SITE_CASH',
    });
  }
  const balanceState = await imprestLedgerModel.getBalanceState(userId, siteId, pool);
  res.json({
    balance: balanceState.available_balance,
    ...balanceState,
    user_id: userId,
  });
});

/**
 * GET /imprest/ledger
 * Get imprest ledger for the logged-in user (or specified user for admin)
 */
export const getLedger = asyncHandler(async (req, res) => {
  const userId = req.query.user_id ? parseInt(req.query.user_id) : req.user.id;
  const { date_from, date_to, page = 1, limit = 20, site_id } = req.query;
  const parsedSiteId = req.imprestSiteId || (site_id ? parseInt(site_id) : null);

  if (req.user.role !== 'admin' && req.user.role !== 'super_admin' && userId !== req.user.id) {
    return res.status(403).json({ message: 'Insufficient permissions' });
  }

  const offset = (parseInt(page) - 1) * parseInt(limit);
  const parsedLimit = parseInt(limit);

  let entries;
  if (date_from || date_to) {
    entries = await imprestLedgerModel.findByUserIdAndDateRange(userId, parsedSiteId, date_from, date_to, parsedLimit, offset, pool);
  } else {
    entries = await imprestLedgerModel.findByUserId(userId, parsedSiteId, parsedLimit, offset, pool);
  }

  entries = await withProofUrls(entries);
  const totalItems = await imprestLedgerModel.countByUserIdAndDateRange(userId, parsedSiteId, date_from, date_to, pool);
  const totalPages = Math.ceil(totalItems / parsedLimit);

  const target = await pool.query('SELECT role FROM users WHERE id = $1', [userId]);
  const balanceState = parsedSiteId && ADMIN_ROLES.has(target.rows[0]?.role)
    ? await (async () => {
      const cash = await siteDistributable(pool, parsedSiteId);
      return {
        posted_balance: cash.cash_balance,
        reserved_amount: Math.max(cash.cash_balance - cash.available, 0),
        available_balance: cash.available,
      };
    })()
    : await imprestLedgerModel.getBalanceState(userId, parsedSiteId, pool);
  const monthly = await imprestLedgerModel.getMonthlySummary(userId, parsedSiteId, pool);

  res.json({
    entries,
    balance: balanceState.available_balance,
    ...balanceState,
    ...(parsedSiteId && ADMIN_ROLES.has(target.rows[0]?.role) ? { balance_source: 'SITE_CASH' } : {}),
    monthly,
    pagination: {
      totalItems,
      totalPages,
      currentPage: parseInt(page),
      itemsPerPage: parsedLimit
    }
  });
});

/**
 * GET /imprest/peers
 * List potential imprest transfer recipients (active staff + Admin) excluding the caller.
 * Allows a sub-admin to pick another user for a peer transfer.
 */
export const listTransferPeers = asyncHandler(async (req, res) => {
  const siteId = req.imprestSiteId || null;
  const { rows } = await pool.query(
    `SELECT u.id, u.name, u.email, u.role
       FROM users u
      WHERE u.is_active = true
        AND u.id != $1
        AND (
          u.role = 'admin'
          OR (
            $2::integer IS NOT NULL
            AND u.role = 'sub_admin'
            AND EXISTS (
              SELECT 1
                FROM user_sites us
               WHERE us.user_id = u.id
                 AND us.site_id = $2
            )
          )
        )
      ORDER BY CASE u.role WHEN 'admin' THEN 0 ELSE 1 END,
               u.name ASC,
               u.email ASC`,
    [req.user.id, siteId]
  );
  res.json({ peers: rows });
});

/**
 * POST /imprest/transfers
 * Move existing imprest funds between two participant balances.
 * Sub-admins can only transfer from their own balance; admins can select both
 * sides. Both ledger entries and the audit record are committed together.
 */
export const createTransfer = asyncHandler(async (req, res) => {
  const { from_user_id, to_user_id, amount, remark } = req.body;
  const siteId = req.imprestSiteId;
  const callerIsAdmin = req.user.role === 'admin' || req.user.role === 'super_admin';
  // Sub-admins can only ever spend their own float — the body is ignored for them.
  // Admins may name a source in the management console. If the source is an
  // Admin account, the transfer is funded from site cash—not a personal float.
  const explicitSource = from_user_id !== undefined && from_user_id !== null && String(from_user_id).trim() !== '';
  const fromUserId = callerIsAdmin && explicitSource ? parseInt(from_user_id, 10) : req.user.id;
  const toUserId = parseInt(to_user_id, 10);
  const transferAmount = Number(amount);

  if (!siteId) return res.status(400).json({ message: 'Site is required' });
  if (!Number.isInteger(fromUserId) || fromUserId <= 0) {
    return res.status(400).json({ message: 'Source account is required' });
  }
  if (!Number.isInteger(toUserId) || toUserId <= 0) {
    return res.status(400).json({ message: 'Recipient is required' });
  }
  if (fromUserId === toUserId) {
    return res.status(400).json({ message: 'Source and recipient must be different users' });
  }
  if (!Number.isFinite(transferAmount) || transferAmount <= 0) {
    return res.status(400).json({ message: 'Amount must be positive' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const [source, recipient] = await Promise.all([
      findEligibleImprestParticipant(fromUserId, siteId, client),
      findEligibleImprestParticipant(toUserId, siteId, client),
    ]);
    if (!source) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'Source account is not available for this site' });
    }
    if (!recipient) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'Recipient is not available for this site' });
    }

    const sourceIsAdmin = ADMIN_ROLES.has(source.role);
    const recipientIsAdmin = ADMIN_ROLES.has(recipient.role);
    if (source.role === 'super_admin' || recipient.role === 'super_admin') {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'Super Admin observes imprest and cannot send or receive float' });
    }
    if (sourceIsAdmin && recipientIsAdmin) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'Admins share the Site Balance; there is no Admin-to-Admin float transfer' });
    }
    if (sourceIsAdmin && !DISTRIBUTOR_ROLES.has(req.user.role)) {
      await client.query('ROLLBACK');
      return res.status(403).json({ code: 'OBSERVER_ROLE', message: 'Only the Admin can distribute site cash' });
    }

    // Site-funded transfers always take the site lock first. Personal accounts
    // then use the shared stable user-lock order.
    let siteCash = null;
    if (sourceIsAdmin) {
      await lockSiteDistribution(client, siteId);
      siteCash = await siteDistributable(client, siteId);
    }
    await lockImprestAccounts(
      client,
      ...(sourceIsAdmin ? [] : [fromUserId]),
      ...(recipientIsAdmin ? [] : [toUserId])
    );

    const sourceBalance = sourceIsAdmin
      ? siteCash.available
      : await imprestLedgerModel.getBalance(fromUserId, siteId, client);
    if (sourceBalance < transferAmount) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        code: sourceIsAdmin ? 'INSUFFICIENT_SITE_BALANCE' : 'INSUFFICIENT_IMPREST',
        message: sourceIsAdmin
          ? `Only ₹${sourceBalance} site cash is available, needed ₹${transferAmount}`
          : `Insufficient imprest balance. Available ₹${sourceBalance}, needed ₹${transferAmount}`,
        balance: sourceBalance,
      });
    }

    const cleanRemark = typeof remark === 'string' && remark.trim() ? remark.trim() : null;
    const transfer = await imprestTransferModel.create({
      site_id: siteId,
      from_user_id: fromUserId,
      to_user_id: toUserId,
      amount: transferAmount,
      remark: cleanRemark,
      initiated_by: req.user.id,
    }, client);

    const narration = cleanRemark ? ` — ${cleanRemark}` : '';
    if (!sourceIsAdmin) {
      await imprestLedgerModel.createEntry({
        user_id: fromUserId,
        type: 'TRANSFER_OUT',
        reference_id: transfer.id,
        amount: -transferAmount,
        remarks: `Transferred to ${recipient.name || recipient.email}${narration}`,
        created_by: req.user.id,
        site_id: siteId,
      }, client);
    }
    if (!recipientIsAdmin) {
      await imprestLedgerModel.createEntry({
        user_id: toUserId,
        type: 'TRANSFER_IN',
        reference_id: transfer.id,
        amount: transferAmount,
        remarks: `Received from ${source.name || source.email}${narration}`,
        created_by: req.user.id,
        site_id: siteId,
      }, client);
    }

    const recipientBalance = recipientIsAdmin
      ? (await siteDistributable(client, siteId)).available
      : await imprestLedgerModel.getBalance(toUserId, siteId, client);
    await client.query('COMMIT');

    res.status(201).json({
      transfer: {
        ...transfer,
        from_user_name: source.name,
        to_user_name: recipient.name,
        initiated_by_name: req.user.name,
      },
      source_balance: sourceBalance - transferAmount,
      recipient_balance: recipientBalance,
      message: recipientIsAdmin
        ? 'Funds returned to the Site Balance.'
        : sourceIsAdmin
          ? 'Site cash transferred successfully.'
          : 'Funds transferred successfully',
    });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
});

/** GET /imprest/transfers — admin sees site history; others see their own. */
export const listTransfers = asyncHandler(async (req, res) => {
  const siteId = req.imprestSiteId;
  if (!siteId) return res.status(400).json({ message: 'Site is required' });

  const callerIsAdmin = req.user.role === 'admin' || req.user.role === 'super_admin';
  const requestedUserId = parseInt(req.query.user_id, 10);
  const userId = callerIsAdmin
    ? (Number.isInteger(requestedUserId) && requestedUserId > 0 ? requestedUserId : null)
    : req.user.id;
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 200);
  const offset = (page - 1) * limit;

  const [transfers, totalItems] = await Promise.all([
    imprestTransferModel.findWithDetails({ siteId, userId, limit, offset }, pool),
    imprestTransferModel.count({ siteId, userId }, pool),
  ]);

  res.json({
    transfers,
    pagination: {
      totalItems,
      totalPages: Math.ceil(totalItems / limit),
      currentPage: page,
      itemsPerPage: limit,
    },
  });
});

/**
 * GET /imprest/all-balances
 * Admin: get every eligible imprest account balance for the selected site
 */
export const getAllBalances = asyncHandler(async (req, res) => {
  const { site_id } = req.query;
  const parsedSiteId = req.imprestSiteId || (site_id ? parseInt(site_id) : null);
  const balances = await imprestLedgerModel.getAllBalances(parsedSiteId, pool);
  res.json({ balances });
});

// ══════════════════════════════════════════════════
//  IMPREST EXPENSE INTEGRATION
// ══════════════════════════════════════════════════

/**
 * POST /imprest/expense
 * Sub-admin submits an imprest expense. The expense remains visible as pending,
 * while its amount is deducted from available imprest immediately so another
 * pending debit cannot spend the same money.
 */
export const createExpenseFromImprest = asyncHandler(async (req, res) => {
  const {
    site_id, date, from_entity, to_entity, payment_mode,
    debit, credit, remark, account_no, branch, category, assigned_admin_id,
  } = req.body;

  if (!site_id) return res.status(400).json({ message: 'Site is required' });
  if (ADMIN_ROLES.has(req.user.role)) {
    return res.status(400).json({
      code: 'ADMIN_USES_SITE_BALANCE',
      message: 'Admins do not have a personal imprest float. Record site expenses in the Expenses module.',
    });
  }

  const expenseAmount = parseFloat(debit) || 0;
  if (expenseAmount <= 0) return res.status(400).json({ message: 'Expense amount must be positive' });

  const proofKey = await uploadProof(req.file);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Check imprest balance
    const parsedSiteId = req.imprestSiteId || parseInt(site_id);
    await lockImprestAccounts(client, req.user.id);
    const currentBalance = await imprestLedgerModel.getBalance(req.user.id, parsedSiteId, client);

    if (currentBalance < expenseAmount) {
      await client.query('ROLLBACK');
      if (proofKey) await deletePlotDoc(proofKey).catch(() => {});
      return res.status(400).json({
        message: `Insufficient imprest balance. Available: ₹${currentBalance}, Required: ₹${expenseAmount}`,
        balance: currentBalance,
        requires_approval: true,
      });
    }

    const expenseDate = date || new Date().toISOString().split('T')[0];

    // 2. Create expense record
    const expenseData = {
      site_id: parsedSiteId,
      date: expenseDate,
      from_entity: from_entity ? from_entity.trim().toUpperCase() : null,
      to_entity: to_entity ? to_entity.trim().toUpperCase() : null,
      payment_mode: payment_mode ? payment_mode.trim().toUpperCase() : null,
      debit: expenseAmount,
      credit: parseFloat(credit) || 0,
      remark: remark ? remark.trim().toUpperCase() : null,
      account_no: account_no ? account_no.trim().toUpperCase() : null,
      branch: branch ? branch.trim().toUpperCase() : null,
      category: category ? category.trim().toUpperCase() : null,
      assigned_admin_id: assigned_admin_id ? parseInt(assigned_admin_id) : null,
      imprest_proof_key: proofKey,
      status: 'pending',
      created_by: req.user.id,
    };

    const expense = await expenseModel.create(expenseData, client);

    await client.query('COMMIT');

    const deductedBalance = await imprestLedgerModel.getBalance(req.user.id, parsedSiteId, pool);

    res.status(201).json({
      expense,
      balance: deductedBalance,
      message: 'Expense submitted for approval and deducted from imprest.',
    });
  } catch (err) {
    await client.query('ROLLBACK');
    if (proofKey) await deletePlotDoc(proofKey).catch(() => {});
    throw err;
  } finally {
    client.release();
  }
});

// ══════════════════════════════════════════════════
//  FUNDING / EXPENSE REQUEST (Sub-Admin → Admin)
// ══════════════════════════════════════════════════

/**
 * POST /imprest/expense-requests
 * Sub-admin requests money (IMPREST type) or approval for an expense (EXPENSE type)
 */
export const createExpenseRequest = asyncHandler(async (req, res) => {
  const {
    site_id, amount, reason,
    date, from_entity, to_entity, payment_mode,
    debit, credit, remark, account_no, branch, category, assigned_admin_id,
    request_type: explicitType,
  } = req.body;

  if (!site_id) return res.status(400).json({ message: 'Site is required' });
  if (ADMIN_ROLES.has(req.user.role)) {
    return res.status(400).json({
      code: 'ADMIN_USES_SITE_BALANCE',
      message: 'Admins use the Site Balance directly and cannot request a personal imprest float.',
    });
  }
  const parsedSiteId = req.imprestSiteId || parseInt(site_id);
  const requestAmount = parseFloat(amount || debit) || 0;
  if (requestAmount <= 0) return res.status(400).json({ message: 'Amount must be positive' });

  // Determine request_type: if no expense-specific fields → IMPREST (cash flow), else EXPENSE.
  const hasExpenseFields = from_entity || to_entity || payment_mode || account_no || branch || category || remark;
  const requestType = explicitType === 'IMPREST' || explicitType === 'EXPENSE'
    ? explicitType
    : hasExpenseFields ? 'EXPENSE' : 'IMPREST';

  const expenseData = {
    site_id: parsedSiteId,
    date: date || new Date().toISOString().split('T')[0],
    from_entity: from_entity ? from_entity.trim().toUpperCase() : null,
    to_entity: to_entity ? to_entity.trim().toUpperCase() : null,
    payment_mode: payment_mode ? payment_mode.trim().toUpperCase() : null,
    debit: requestAmount,
    credit: parseFloat(credit) || 0,
    remark: remark ? remark.trim().toUpperCase() : null,
    account_no: account_no ? account_no.trim().toUpperCase() : null,
    branch: branch ? branch.trim().toUpperCase() : null,
    category: category ? category.trim().toUpperCase() : null,
    assigned_admin_id: assigned_admin_id ? parseInt(assigned_admin_id) : null,
  };

  const request = await imprestExpenseRequestModel.create({
    sub_admin_id: req.user.id,
    site_id: parsedSiteId,
    amount: requestAmount,
    expense_data: JSON.stringify(expenseData),
    reason: reason ? reason.trim() : null,
    assigned_admin_id: assigned_admin_id ? parseInt(assigned_admin_id) : null,
    request_type: requestType,
    status: 'PENDING',
  }, pool);

  res.status(201).json({
    request,
    message: requestType === 'IMPREST'
      ? 'Imprest request submitted for admin approval'
      : 'Expense request submitted for admin approval',
  });
});

/**
 * GET /imprest/expense-requests
 * Admin: list all pending requests; Sub-admin: list own requests
 */
export const listExpenseRequests = asyncHandler(async (req, res) => {
  const { site_id, status } = req.query;

  const parsedSiteId = req.imprestSiteId || (site_id ? parseInt(site_id) : null);

  let requests;
  if (req.user.role === 'admin' || req.user.role === 'super_admin') {
    if (status === 'PENDING') {
      requests = await imprestExpenseRequestModel.findPending(parsedSiteId, pool);
    } else {
      requests = await imprestExpenseRequestModel.findAllWithDetails(parsedSiteId, pool);
    }
  } else {
    requests = await imprestExpenseRequestModel.findBySubAdminId(req.user.id, parsedSiteId, pool);
  }

  res.json({ requests });
});

/**
 * PUT /imprest/expense-requests/:id/approve
 * Admin approves: IMPREST type → allocation (positive cash flow), EXPENSE type
 * → expense deducted from the requester's available imprest.
 */
export const approveExpenseRequest = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { review_remark } = req.body;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Approve the request
    const request = await imprestExpenseRequestModel.approveRequest(
      parseInt(id),
      req.user.id,
      review_remark ? review_remark.trim() : null,
      client
    );

    if (!request) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Request not found or already processed' });
    }

    // Re-check at approval time: a requester may have been deactivated or
    // removed from the site after submitting the request. Do not create a new
    // allocation/expense ledger entry for an ineligible site participant.
    const eligibleRequester = await findEligibleImprestParticipant(
      request.sub_admin_id,
      request.site_id,
      client
    );
    if (!eligibleRequester) {
      await client.query('ROLLBACK');
      return res.status(409).json({ message: 'The requester is no longer active or assigned to this site' });
    }

    const requestType = request.request_type || 'EXPENSE';
    const requestAmount = parseFloat(request.amount);

    // ── IMPREST type: just allocate cash to sub-admin (no expense, no daybook expense) ──
    if (requestType === 'IMPREST') {
      // A requested allocation is still a distribution of Admin Site Balance.
      // Serialize it with direct allocations, and use the same transaction for
      // the custody snapshot so concurrent approvals cannot mint staff float.
      await lockSiteDistribution(client, request.site_id);
      const distributable = await siteDistributable(client, request.site_id);
      if (requestAmount > distributable.available + 0.005) {
        await client.query('ROLLBACK');
        const shortfall = Math.round((requestAmount - Math.max(distributable.available, 0)) * 100) / 100;
        return res.status(400).json({
          code: 'INSUFFICIENT_SITE_BALANCE',
          ...distributable,
          shortfall,
          message: distributable.available <= 0
            ? `No site cash is available to approve this request. ${FUNDING_HINT}`
            : `Only ₹${distributable.available.toLocaleString('en-IN')} cash is available (₹${shortfall.toLocaleString('en-IN')} short).`,
        });
      }

      await lockImprestAccounts(client, request.sub_admin_id);

      // 2a. Create allocation record
      const allocation = await imprestAllocationModel.create({
        admin_id: req.user.id,
        sub_admin_id: request.sub_admin_id,
        amount: requestAmount,
        remark: request.reason || 'Imprest request approved',
        assigned_admin_id: request.assigned_admin_id || null,
        site_id: request.site_id,
        from_own_float: false,
        site_balance_at_allocation: distributable.available,
        override_reason: null,
        status: 'RECEIVED', // auto-confirmed since sub-admin requested it
        confirmed_at: new Date(),
        confirmation_remark: 'Auto-confirmed (requested by sub-admin)',
      }, client);

      // 3a. Add positive balance to imprest ledger
      await imprestLedgerModel.createEntry({
        user_id: request.sub_admin_id,
        type: 'ALLOCATION',
        reference_id: allocation.id,
        amount: requestAmount,
        remarks: `Imprest allocated (request #${request.id} approved): ${request.reason || ''}`.trim(),
        created_by: req.user.id,
        site_id: request.site_id,
      }, client);

      await client.query('COMMIT');

      return res.json({
        request,
        allocation,
        message: 'Imprest request approved — funds allocated to sub-admin',
      });
    }

    // ── EXPENSE type: the database atomically verifies and deducts imprest ──
    await lockImprestAccounts(client, request.sub_admin_id);
    const storedExpenseData = typeof request.expense_data === 'string'
      ? JSON.parse(request.expense_data)
      : request.expense_data;
    // The request row owns the authoritative site. Never trust a stale or
    // legacy JSON payload to direct the approved expense into another site.
    const expenseData = { ...storedExpenseData, site_id: request.site_id };
    const expenseAmount = parseFloat(expenseData.debit) || requestAmount;

    // 2b. Create the expense
    const expense = await expenseModel.create({
      ...expenseData,
      status: 'approved',
      approved_by: req.user.id,
      created_by: request.sub_admin_id,
    }, client);

    // 3b. Create a memo Day Book entry. The approved expense is the owning
    // financial row, so this IMPREST row stays outside universal debit posting.
    const dayBookData = {
      site_id: parseInt(request.site_id),
      date: expenseData.date || new Date().toISOString().split('T')[0],
      particular: `IMPREST EXPENSE: ${expenseData.remark || expenseData.to_entity || 'ADMIN APPROVED'}`.toUpperCase(),
      // ponytail: entry_type IMPREST — the approved expenses row already reaches
      // ledger_entries; this memo row must stay excluded or the spend counts twice.
      entry_type: 'IMPREST',
      debit: expenseAmount,
      credit: parseFloat(expenseData.credit) || 0,
      remarks: `Imprest expense approved by admin. ${review_remark || ''}`.trim().toUpperCase(),
      payment_mode: expenseData.payment_mode || null,
      category: expenseData.category || null,
      from_entity: expenseData.from_entity || null,
      to_entity: expenseData.to_entity || null,
      account_no: expenseData.account_no || null,
      branch: expenseData.branch || null,
      status: 'approved',
      approved_by: req.user.id,
      approved_at: new Date(),
      created_by: request.sub_admin_id,
      is_imprest_internal: true,
    };

    await dayBookModel.create(dayBookData, client);

    await client.query('COMMIT');

    res.json({
      request,
      expense,
      message: 'Expense request approved and deducted from imprest',
    });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

/**
 * PUT /imprest/expense-requests/:id/reject
 * Admin rejects an expense request
 */
export const rejectExpenseRequest = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { review_remark } = req.body;

  const request = await imprestExpenseRequestModel.rejectRequest(
    parseInt(id),
    req.user.id,
    review_remark ? review_remark.trim() : null,
    pool
  );

  if (!request) return res.status(404).json({ message: 'Request not found or already processed' });

  res.json({ request, message: 'Expense request rejected' });
});

// ══════════════════════════════════════════════════
//  IMPREST ADJUSTMENT (Admin)
// ══════════════════════════════════════════════════

/**
 * POST /imprest/adjust
 * Admin manually adjusts a sub-admin's imprest balance
 */
export const adjustBalance = asyncHandler(async (req, res) => {
  const { user_id, amount, remarks, date, site_id } = req.body;

  if (!user_id) return res.status(400).json({ message: 'User ID is required' });
  if (amount === undefined || amount === null) return res.status(400).json({ message: 'Amount is required' });
  if (!DISTRIBUTOR_ROLES.has(req.user.role)) {
    return res.status(403).json({ code: 'OBSERVER_ROLE', message: 'Imprest balances are adjusted by the Admin. Super Admin observes.' });
  }
  if (ADMIN_ROLES.has(req.imprestParticipants?.user_id?.role)) {
    return res.status(400).json({ message: 'Admins use the Site Balance and do not have an adjustable personal float' });
  }
  const parsedSiteId = req.imprestSiteId || parseInt(site_id);
  const adjustAmount = parseFloat(amount);
  if (!Number.isFinite(adjustAmount) || adjustAmount === 0) return res.status(400).json({ message: 'Amount must be a non-zero number' });
  const proofKey = await uploadProof(req.file);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // A positive adjustment puts site money into someone's float — same rule as an allocation.
    if (adjustAmount > 0) {
      await lockSiteDistribution(client, parsedSiteId);
      const distributable = await siteDistributable(client, parsedSiteId);
      if (adjustAmount > distributable.available + 0.005) {
        await client.query('ROLLBACK');
        if (proofKey) await deletePlotDoc(proofKey).catch(() => {});
        return res.status(400).json({
          code: 'INSUFFICIENT_SITE_BALANCE', ...distributable,
          shortfall: Math.round((adjustAmount - Math.max(distributable.available, 0)) * 100) / 100,
          message: `Only ₹${distributable.available.toLocaleString('en-IN')} site cash is available. ${FUNDING_HINT}`,
        });
      }
    }
    await lockImprestAccounts(client, parseInt(user_id));

    if (adjustAmount < 0) {
      const currentBalance = await imprestLedgerModel.getBalance(parseInt(user_id), parsedSiteId, client);
      const required = Math.abs(adjustAmount);
      if (currentBalance + 0.005 < required) {
        await client.query('ROLLBACK');
        if (proofKey) await deletePlotDoc(proofKey).catch(() => {});
        const available = Math.max(currentBalance, 0);
        return res.status(400).json({
          code: 'INSUFFICIENT_IMPREST',
          balance: currentBalance,
          available,
          required,
          shortfall: Math.round((required - available) * 100) / 100,
          message: `Insufficient imprest balance. Available: ₹${currentBalance}, Required: ₹${required}`,
        });
      }
    }

    // Create ledger adjustment
    const entry = await imprestLedgerModel.createEntry({
      user_id: parseInt(user_id),
      type: 'ADJUSTMENT',
      reference_id: null,
      amount: parseFloat(amount),
      remarks: remarks ? remarks.trim().toUpperCase() : 'ADMIN ADJUSTMENT',
      created_by: req.user.id,
      site_id: parsedSiteId,
      proof_key: proofKey,
    }, client);

    // Day Book entry for audit trail
    const userResult = await client.query('SELECT name FROM users WHERE id = $1', [parseInt(user_id)]);
    const userName = userResult.rows[0]?.name || 'Sub-Admin';

    const dayBookData = {
      site_id: parsedSiteId,
      date: date || new Date().toISOString().split('T')[0],
      particular: `IMPREST ADJUSTMENT FOR ${userName.toUpperCase()}`,
      entry_type: 'IMPREST',
      debit: parseFloat(amount) < 0 ? Math.abs(parseFloat(amount)) : 0,
      credit: parseFloat(amount) > 0 ? parseFloat(amount) : 0,
      remarks: remarks ? remarks.trim().toUpperCase() : 'MANUAL IMPREST ADJUSTMENT',
      payment_mode: 'CASH',
      category: 'IMPREST',
      status: 'approved',
      created_by: req.user.id,
      is_imprest_internal: true,
    };

    await dayBookModel.create(dayBookData, client);

    await client.query('COMMIT');

    const balance = await imprestLedgerModel.getBalance(parseInt(user_id), parsedSiteId, pool);

    res.json({ entry, balance, message: 'Balance adjusted successfully' });
  } catch (err) {
    await client.query('ROLLBACK');
    if (proofKey) await deletePlotDoc(proofKey).catch(() => {});
    throw err;
  } finally {
    client.release();
  }
});

// ══════════════════════════════════════════════════
//  IMPREST RETURN (Sub-Admin → Admin)
// ══════════════════════════════════════════════════

/**
 * POST /imprest/returns
 * Sub-admin initiates returning money back to admin
 */
export const createReturn = asyncHandler(async (req, res) => {
  const { amount, reason, site_id, assigned_admin_id } = req.body;

  if (ADMIN_ROLES.has(req.user.role)) {
    return res.status(400).json({
      code: 'ADMIN_USES_SITE_BALANCE',
      message: 'Admins do not return imprest because they already hold the Site Balance.',
    });
  }

  const returnAmount = parseFloat(amount);
  if (!returnAmount || returnAmount <= 0) {
    return res.status(400).json({ message: 'Amount must be positive' });
  }

  const parsedSiteId = req.imprestSiteId || parseInt(site_id);
  const proofKey = await uploadProof(req.file);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Serialize with other imprest mutations so the balance check is race-free.
    await lockImprestAccounts(client, req.user.id);
    const currentBalance = await imprestLedgerModel.getBalance(req.user.id, parsedSiteId, client);
    if (currentBalance < returnAmount) {
      await client.query('ROLLBACK');
      if (proofKey) await deletePlotDoc(proofKey).catch(() => {});
      return res.status(400).json({
        message: `Insufficient balance. You have ${currentBalance} but tried to return ${returnAmount}`,
        balance: currentBalance,
      });
    }

    const returnRecord = await imprestReturnModel.create({
      sub_admin_id: req.user.id,
      amount: returnAmount,
      reason: reason ? reason.trim() : null,
      payment_mode: 'CASH',
      site_id: parsedSiteId,
      assigned_admin_id: assigned_admin_id ? parseInt(assigned_admin_id) : null,
      proof_key: proofKey,
      status: 'PENDING',
    }, client);

    await client.query('COMMIT');
    res.status(201).json({
      return: returnRecord,
      message: 'Return request submitted. Waiting for admin acceptance.',
    });
  } catch (err) {
    await client.query('ROLLBACK');
    if (proofKey) await deletePlotDoc(proofKey).catch(() => {});
    throw err;
  } finally {
    client.release();
  }
});

/**
 * GET /imprest/returns
 * Admin: all returns; Sub-admin: own returns
 */
export const listReturns = asyncHandler(async (req, res) => {
  const { site_id } = req.query;
  const parsedSiteId = req.imprestSiteId || (site_id ? parseInt(site_id) : null);

  let returns;
  if (req.user.role === 'admin' || req.user.role === 'super_admin') {
    returns = await imprestReturnModel.findAllWithDetails(parsedSiteId, pool);
  } else {
    returns = await imprestReturnModel.findBySubAdminId(req.user.id, parsedSiteId, pool);
  }
  res.json({ returns: await withProofUrls(returns) });
});

/**
 * GET /imprest/pending-returns
 * Admin: pending returns needing review
 */
export const getPendingReturns = asyncHandler(async (req, res) => {
  const { site_id } = req.query;
  const parsedSiteId = req.imprestSiteId || (site_id ? parseInt(site_id) : null);
  const returns = await imprestReturnModel.findPending(parsedSiteId, pool);
  res.json({ returns: await withProofUrls(returns) });
});

/**
 * PUT /imprest/returns/:id/accept
 * Admin accepts a return — deducts from sub-admin's imprest ledger + day book
 */
export const acceptReturn = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { review_remark } = req.body;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Accept the return record
    const returnRecord = await imprestReturnModel.acceptReturn(
      parseInt(id),
      req.user.id,
      review_remark ? review_remark.trim() : null,
      client
    );

    if (!returnRecord) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Return not found or already processed' });
    }

    const returnAmount = parseFloat(returnRecord.amount);

    // 2. Verify sub-admin still has sufficient balance
    const returnSiteId = returnRecord.site_id ? parseInt(returnRecord.site_id) : null;
    await lockImprestAccounts(client, returnRecord.sub_admin_id);
    const currentBalance = await imprestLedgerModel.getBalance(returnRecord.sub_admin_id, returnSiteId, client);
    if (currentBalance < returnAmount) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        message: `Sub-admin balance (${currentBalance}) is now less than return amount (${returnAmount}). Cannot accept.`,
      });
    }

    // 3. Deduct from sub-admin's imprest ledger (negative = deduction)
    await imprestLedgerModel.createEntry({
      user_id: returnRecord.sub_admin_id,
      type: 'REFUND',
      reference_id: returnRecord.id,
      amount: -returnAmount,
      remarks: `IMPREST RETURN #${returnRecord.id} ACCEPTED BY ADMIN. ${returnRecord.reason || ''}`.trim(),
      created_by: req.user.id,
      site_id: returnSiteId,
    }, client);

    // 4. Create Day Book entry (DEBIT from sub-admin back to admin)
    const subAdminResult = await client.query('SELECT name FROM users WHERE id = $1', [returnRecord.sub_admin_id]);
    const subAdminName = subAdminResult.rows[0]?.name || 'Sub-Admin';

    const dayBookData = {
      site_id: returnSiteId,
      date: new Date().toISOString().split('T')[0],
      particular: `IMPREST RETURN FROM ${subAdminName.toUpperCase()}`,
      entry_type: 'IMPREST',
      debit: returnAmount,
      credit: 0,
      remarks: `IMPREST RETURN: ${returnRecord.reason || 'UNUSED FUNDS RETURNED'}`.toUpperCase(),
      payment_mode: returnRecord.payment_mode || 'CASH',
      category: 'IMPREST',
      from_entity: subAdminName.toUpperCase(),
      to_entity: 'ADMIN',
      status: 'approved',
      created_by: req.user.id,
      is_imprest_internal: true,
    };

    await dayBookModel.create(dayBookData, client);

    await client.query('COMMIT');

    const newBalance = await imprestLedgerModel.getBalance(returnRecord.sub_admin_id, returnSiteId, pool);

    res.json({
      return: returnRecord,
      balance: newBalance,
      message: 'Return accepted. Imprest balance updated.',
    });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

/**
 * PUT /imprest/returns/:id/reject
 * Admin rejects a return — no balance change
 */
export const rejectReturn = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { review_remark } = req.body;

  const returnRecord = await imprestReturnModel.rejectReturn(
    parseInt(id),
    req.user.id,
    review_remark ? review_remark.trim() : null,
    pool
  );

  if (!returnRecord) {
    return res.status(404).json({ message: 'Return not found or already processed' });
  }

  res.json({ return: returnRecord, message: 'Return request rejected' });
});
