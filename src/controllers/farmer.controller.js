import { transactionTimeForWrite } from '../services/transactionTime.service.js';
import asyncHandler from '../utils/asyncHandler.js';
import { farmerModel, farmerPaymentModel } from '../models/Farmer.model.js';
import { dayBookModel } from '../models/DayBook.model.js';
import pool from '../config/db.js';
import { buildVerifyUrl, verifyReceiptToken, ReceiptType } from '../utils/receiptToken.js';
import { resolveEntryVisibility } from '../services/entryVisibility.service.js';
import { reverseApprovedImprestDebit } from '../services/imprestPosting.service.js';
import {
  FarmerPaymentValidationError,
  farmerPaymentFieldsTouched,
  normalizeFarmerPaymentInput,
  rebuildFarmerPaymentDayBook,
} from '../services/farmerPayment.service.js';

const GAZ_TO_SQ_METRE = 0.8364;

const parseOptionalArea = (value) => {
  if (value === '' || value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const normalizeFarmerArea = (gazValue, metreValue) => {
  const gaz = parseOptionalArea(gazValue);
  if (gaz !== null) {
    return {
      land_size_gaz: Number(gaz.toFixed(4)),
      land_size_mtr: Number((gaz * GAZ_TO_SQ_METRE).toFixed(4)),
    };
  }

  const metres = parseOptionalArea(metreValue);
  if (metres !== null) {
    return {
      land_size_gaz: Number((metres / GAZ_TO_SQ_METRE).toFixed(4)),
      land_size_mtr: Number(metres.toFixed(4)),
    };
  }

  return { land_size_gaz: null, land_size_mtr: null };
};

// ──────────────────────────────────────────────────────────────
// FARMER CRUD
// ──────────────────────────────────────────────────────────────

/**
 * POST /farmers
 * Create a new farmer (admin only)
 */
export const createFarmer = asyncHandler(async (req, res) => {
  const {
    name, phone, address, total_amount, interest_rate, site_id, notes, status, member_id,
    payment_mode, cash_amount, bank_amount, bank_name, bank_account_no, bank_reference, bank_ifsc,
    land_size_bigha, land_size_gaz, land_size_mtr, land_rate, commission_percentage, commission_amount,
  } = req.body;

  if (!name) {
    return res.status(400).json({ message: 'Farmer name is required' });
  }
  if (!site_id) {
    return res.status(400).json({ message: 'Site is required' });
  }

  const mode = (payment_mode || 'CASH').toUpperCase();
  const totalAmt = parseFloat(total_amount) || 0;
  const cashAmt = mode === 'BANK' ? 0 : (mode === 'SPLIT' ? (parseFloat(cash_amount) || 0) : totalAmt);
  const bankAmt = mode === 'CASH' ? 0 : (mode === 'SPLIT' ? (parseFloat(bank_amount) || 0) : totalAmt);
  const normalizedArea = normalizeFarmerArea(land_size_gaz, land_size_mtr);

  const farmerData = {
    name,
    phone: phone || null,
    address: address || null,
    total_amount: totalAmt,
    interest_rate: interest_rate || 0,
    site_id: parseInt(site_id),
    created_by: req.user.id,
    notes: notes || null,
    status: status || 'active',
    member_id: member_id ? parseInt(member_id) : null,
    payment_mode: mode,
    cash_amount: cashAmt,
    bank_amount: bankAmt,
    bank_name: bank_name || null,
    bank_account_no: bank_account_no || null,
    bank_reference: bank_reference || null,
    bank_ifsc: bank_ifsc || null,
    land_size_bigha: land_size_bigha != null && land_size_bigha !== '' ? parseFloat(land_size_bigha) : null,
    ...normalizedArea,
    land_rate: land_rate != null && land_rate !== '' ? parseFloat(land_rate) : null,
    commission_percentage: commission_percentage != null && commission_percentage !== '' ? parseFloat(commission_percentage) : null,
    commission_amount: commission_amount != null && commission_amount !== '' ? parseFloat(commission_amount) : null,
  };

  const farmer = await farmerModel.create(farmerData, pool);
  res.status(201).json({ farmer });
});

/**
 * GET /farmers?site_id=X
 * List farmers for a site
 */
export const listFarmers = asyncHandler(async (req, res) => {
  const { site_id } = req.query;

  if (!site_id) {
    return res.status(400).json({ message: 'site_id query param is required' });
  }

  const farmers = await farmerModel.findBySiteId(parseInt(site_id), pool);
  res.json({ farmers });
});

/**
 * GET /farmers/:id
 * Get single farmer with summary
 */
export const getFarmer = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const farmer = await farmerModel.findByIdWithSummary(parseInt(id), pool);

  if (!farmer) {
    return res.status(404).json({ message: 'Farmer not found' });
  }

  res.json({ farmer });
});

/**
 * PUT /farmers/:id
 * Update a farmer
 */
export const updateFarmer = asyncHandler(async (req, res) => {
  const farmerId = parseInt(req.params.id);
  const {
    name, phone, address, total_amount, interest_rate, notes, status, member_id,
    payment_mode, cash_amount, bank_amount, bank_name, bank_account_no, bank_reference, bank_ifsc,
    land_size_bigha, land_size_gaz, land_size_mtr, land_rate, commission_percentage, commission_amount,
  } = req.body;

  // Build the update set without an extra existence-check round-trip — the
  // UPDATE itself returns 0 rows if the id doesn't exist.
  const updateData = {};
  if (name !== undefined) updateData.name = name;
  if (phone !== undefined) updateData.phone = phone;
  if (address !== undefined) updateData.address = address;
  if (total_amount !== undefined) updateData.total_amount = total_amount;
  if (interest_rate !== undefined) updateData.interest_rate = interest_rate;
  if (notes !== undefined) updateData.notes = notes;
  if (status !== undefined) updateData.status = status;
  if (member_id !== undefined) updateData.member_id = member_id ? parseInt(member_id) : null;
  if (payment_mode !== undefined) updateData.payment_mode = payment_mode;
  if (cash_amount !== undefined) updateData.cash_amount = cash_amount;
  if (bank_amount !== undefined) updateData.bank_amount = bank_amount;
  if (bank_name !== undefined) updateData.bank_name = bank_name;
  if (bank_account_no !== undefined) updateData.bank_account_no = bank_account_no;
  if (bank_reference !== undefined) updateData.bank_reference = bank_reference;
  if (bank_ifsc !== undefined) updateData.bank_ifsc = bank_ifsc;
  if (land_size_bigha !== undefined) updateData.land_size_bigha = land_size_bigha != null && land_size_bigha !== '' ? parseFloat(land_size_bigha) : null;
  if (land_size_gaz !== undefined || land_size_mtr !== undefined) {
    Object.assign(updateData, normalizeFarmerArea(land_size_gaz, land_size_mtr));
  }
  if (land_rate !== undefined) updateData.land_rate = land_rate != null && land_rate !== '' ? parseFloat(land_rate) : null;
  if (commission_percentage !== undefined) updateData.commission_percentage = commission_percentage != null && commission_percentage !== '' ? parseFloat(commission_percentage) : null;
  if (commission_amount !== undefined) updateData.commission_amount = commission_amount != null && commission_amount !== '' ? parseFloat(commission_amount) : null;

  if (Object.keys(updateData).length === 0) {
    return res.status(400).json({ message: 'Nothing to update' });
  }

  updateData.status = 'pending';
  updateData.approved_by = null;
  updateData.approved_at = null;
  const finalMode = String(payment_mode !== undefined ? payment_mode : '').trim().toUpperCase();
  if (payment_mode !== undefined) updateData.cheque_status = finalMode === 'CHEQUE' ? 'PENDING' : null;

  const updated = await farmerModel.update(farmerId, updateData, pool);
  if (!updated) {
    return res.status(404).json({ message: 'Farmer not found' });
  }
  res.json({ farmer: updated });
});

/**
 * DELETE /farmers/:id
 * Delete a farmer and all payments
 */
export const deleteFarmer = asyncHandler(async (req, res) => {
  // Atomic DELETE — if no row was deleted, return 404. Saves a SELECT round-trip.
  const result = await pool.query(
    `DELETE FROM farmers WHERE id = $1 RETURNING id`,
    [parseInt(req.params.id)]
  );
  if (!result.rows[0]) {
    return res.status(404).json({ message: 'Farmer not found' });
  }
  res.json({ message: 'Farmer deleted' });
});

/**
 * POST /farmers/bulk-delete
 * Body: { ids: number[] }. Same as deleteFarmer — a farmer with existing
 * payments fails on the DB's FK constraint exactly as the single-delete
 * route already does; no new validation is invented here.
 */
export const bulkDeleteFarmers = asyncHandler(async (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids.map((id) => parseInt(id)).filter(Number.isInteger) : [];
  if (ids.length === 0) return res.status(400).json({ message: 'ids array is required' });

  const result = await pool.query(`DELETE FROM farmers WHERE id = ANY($1::int[]) RETURNING id`, [ids]);
  res.json({ message: `${result.rows.length} farmer(s) deleted`, deleted: result.rows.map((r) => r.id) });
});


// ──────────────────────────────────────────────────────────────
// FARMER PAYMENTS (INSTALLMENTS) CRUD
// ──────────────────────────────────────────────────────────────

/**
 * POST /farmers/:farmerId/payments
 * Add a payment/installment to a farmer with cash/bank split + DayBook integration
 */
export const createPayment = asyncHandler(async (req, res) => {
  const { farmerId } = req.params;
  const {
    date, particular, amount, by_note, remarks,
    payment_mode, cash_amount, bank_amount, bank_name, bank_account_no, bank_reference, bank_ifsc,
    voucher_url, assigned_admin_id,
  } = req.body;

  if (!particular) {
    return res.status(400).json({ message: 'Particular (payment method) is required' });
  }

  const farmerIdInt = parseInt(farmerId);
  if (!Number.isInteger(farmerIdInt) || farmerIdInt <= 0) {
    return res.status(400).json({ message: 'A valid farmer id is required' });
  }

  let normalizedPayment;
  try {
    normalizedPayment = normalizeFarmerPaymentInput(req.body);
  } catch (error) {
    if (error instanceof FarmerPaymentValidationError) {
      return res.status(400).json({ code: error.code, message: error.message });
    }
    throw error;
  }
  const {
    amount: totalAmount,
    payment_mode: mode,
    cash_amount: cashAmt,
    bank_amount: bankAmt,
  } = normalizedPayment;
  const paymentDate = date || new Date().toISOString().split('T')[0];
  const adminId = assigned_admin_id ? parseInt(assigned_admin_id) : null;
  const chequeNo = req.body.cheque_no ? String(req.body.cheque_no).trim() : null;
  const chequeStatus = mode === 'CHEQUE' ? 'PENDING' : null;
  const userId = req.user.id;
  const trimmedRemarks = remarks ? remarks.trim() : null;
  const particularUpper = String(particular).toUpperCase();
  const bankNameUpper = bank_name ? String(bank_name).toUpperCase() : null;
  const bankRemarks = [remarks, bank_reference ? `Ref: ${bank_reference}` : null, bank_name ? `Bank: ${bank_name}` : null].filter(Boolean).join(' | ') || null;

  // ─────────────────────────────────────────────────────────────
  // SINGLE-ROUND-TRIP create: farmer lookup + payment INSERT + 0/1/2
  // day_book INSERTs in one CTE. Previously this was 3 serial round-trips
  // (SELECT farmer → INSERT payment → INSERT day_book ×N).
  // ─────────────────────────────────────────────────────────────
  const result = await pool.query(
    `WITH f AS (
       SELECT id, site_id, name FROM farmers WHERE id = $1
     ),
     new_payment AS (
       INSERT INTO farmer_payments (
         farmer_id, date, particular, amount, by_note, remarks,
         payment_mode, cash_amount, bank_amount, bank_name, bank_account_no,
         bank_reference, bank_ifsc, voucher_url, assigned_admin_id, status,
         cheque_no, cheque_status, created_by, transaction_time
       )
       SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, 'pending', $16, $17, $18, $25::time
       FROM f
       RETURNING *
     ),
     db_cash AS (
       INSERT INTO day_book (
         site_id, date, particular, entry_type, debit, credit, remarks,
         payment_mode, category, from_entity, to_entity,
         created_by, assigned_admin_id, farmer_payment_id, transaction_time
       )
       SELECT
         f.site_id,
         $2::date,
         (UPPER(f.name) || ' - FARMER PAYMENT (CASH)'),
         'FARMER PAYMENT',
         $19::numeric, 0, $20::text,
         'CASH', 'FARMER PAYMENT', NULL, UPPER(f.name),
         $18::int, $15::int, np.id, $25::time
       FROM f, new_payment np
       WHERE $19::numeric > 0
       RETURNING *
     ),
     db_bank AS (
       INSERT INTO day_book (
         site_id, date, particular, entry_type, debit, credit, remarks,
         payment_mode, category, from_entity, to_entity,
         account_no, branch, created_by, assigned_admin_id, farmer_payment_id, transaction_time
       )
       SELECT
         f.site_id,
         $2::date,
         (UPPER(f.name) || ' - FARMER PAYMENT (BANK)'),
         'FARMER PAYMENT',
         $21::numeric, 0, $22::text,
         $23::text, 'FARMER PAYMENT', $24::text, UPPER(f.name),
         $11::text, $13::text, $18::int, $15::int, np.id, $25::time
       FROM f, new_payment np
       WHERE $21::numeric > 0
       RETURNING *
     )
     SELECT
       (SELECT row_to_json(np) FROM new_payment np) AS payment,
       COALESCE(
         (SELECT json_agg(row_to_json(d)) FROM (SELECT * FROM db_cash UNION ALL SELECT * FROM db_bank) d),
         '[]'::json
       ) AS daybook_entries,
       (SELECT id FROM f) AS farmer_id`,
    [
      farmerIdInt,                  // $1
      paymentDate,                  // $2
      particular,                   // $3
      totalAmount,                  // $4
      by_note || null,              // $5
      remarks || null,              // $6
      mode,                         // $7
      cashAmt,                      // $8
      bankAmt,                      // $9
      bank_name || null,            // $10
      bank_account_no || null,      // $11
      bank_reference || null,       // $12
      bank_ifsc || null,            // $13
      voucher_url || null,          // $14
      adminId,                      // $15
      chequeNo,                     // $16
      chequeStatus,                 // $17
      userId,                       // $18
      cashAmt,                      // $19 (cash debit / WHERE > 0)
      trimmedRemarks,               // $20 (cash remarks)
      bankAmt,                      // $21 (bank debit / WHERE > 0)
      bankRemarks,                  // $22 (bank remarks)
      particularUpper,              // $23 (bank payment_mode)
      bankNameUpper,                // $24 (bank from_entity)
      transactionTimeForWrite(),    // $25
    ]
  );

  const row = result.rows[0];
  if (!row || !row.payment) {
    return res.status(404).json({ message: 'Farmer not found' });
  }

  res.status(201).json({
    payment: row.payment,
    daybook_entries: row.daybook_entries || [],
  });
});

/**
 * GET /farmers/:farmerId/payments
 * List all payments for a farmer
 */
export const listPayments = asyncHandler(async (req, res) => {
  const farmerId = parseInt(req.params.farmerId);
  const entryVisibility = await resolveEntryVisibility(req.user, 'farmers', req.query.created_by);

  // The previous implementation ran 4–5 SERIAL queries:
  //   findByIdWithSummary → findByFarmerId → getTotalPaid → getTotalInterest → site
  // findByIdWithSummary already returns total_paid + total_interest, so two of
  // those queries were duplicated work. Now: 2 parallel reads (farmer+site,
  // payments) and totals are derived from the data we already have.
  const farmerWithSitePromise = pool.query(
    `SELECT
       f.*,
       COALESCE(SUM(fp.amount), 0) AS total_paid,
       COALESCE(SUM(fp.interest_amount), 0) AS total_interest,
       COUNT(fp.id) AS payment_count,
       -- Same CASE the farmers LIST page uses (Farmer.model.js findBySiteId),
       -- so both pages report the same Cash/Bank split for a farmer. Summing
       -- fp.cash_amount / fp.bank_amount in JS did NOT: those columns are 0/0
       -- for CHEQUE rows, so cheque payments counted in neither book.
       COALESCE(SUM(
         CASE
           WHEN UPPER(COALESCE(fp.payment_mode, '')) = 'SPLIT' THEN COALESCE(fp.cash_amount, 0)
           WHEN ledger_bucket(fp.payment_mode) = 'cash' THEN fp.amount
           ELSE 0
         END
       ), 0) AS cash_paid,
       COALESCE(SUM(
         CASE
           WHEN UPPER(COALESCE(fp.payment_mode, '')) = 'SPLIT' THEN COALESCE(fp.bank_amount, 0)
           WHEN ledger_bucket(fp.payment_mode) = 'cash' THEN 0
           ELSE fp.amount
         END
       ), 0) AS bank_paid,
       s.name  AS site_name,
       s.code  AS site_code,
       s.address AS site_address,
       s.city  AS site_city,
       s.state AS site_state
     FROM farmers f
     LEFT JOIN farmer_payments fp ON fp.farmer_id = f.id
       AND financial_transaction_posts('debit', fp.status, fp.payment_mode, fp.cheque_status)
       AND ($2::int IS NULL OR fp.created_by = $2::int)
     LEFT JOIN sites s ON s.id = f.site_id
     WHERE f.id = $1
     GROUP BY f.id, s.id`,
    [farmerId, entryVisibility.creatorId]
  );
  const paymentsPromise = farmerPaymentModel.findByFarmerId(farmerId, pool, entryVisibility.creatorId);

  const [farmerRes, payments] = await Promise.all([farmerWithSitePromise, paymentsPromise]);
  const farmer = farmerRes.rows[0];
  if (!farmer) {
    return res.status(404).json({ message: 'Farmer not found' });
  }

  const cashPaid = parseFloat(farmer.cash_paid) || 0;
  const bankPaid = parseFloat(farmer.bank_paid) || 0;
  const totalPaid = parseFloat(farmer.total_paid) || 0;
  const totalInterest = parseFloat(farmer.total_interest) || 0;

  const paymentsWithVerify = payments.map((p) => ({
    ...p,
    verifyUrl: buildVerifyUrl({
      t: ReceiptType.FARMER,
      i: p.id,
      fn: farmer.name || null,
      a: p.amount,
      d: p.date,
      pm: p.payment_mode || null,
      sn: farmer.site_name || null,
      sy: farmer.site_city || null,
      ss: farmer.site_state || null,
    }),
  }));

  res.json({
    farmer,
    payments: paymentsWithVerify,
    summary: {
      total_amount: parseFloat(farmer.total_amount),
      total_paid: totalPaid,
      total_interest: totalInterest,
      remaining: parseFloat(farmer.total_amount) - totalPaid,
      cash_to_pay: parseFloat(farmer.cash_amount) || 0,
      bank_to_pay: parseFloat(farmer.bank_amount) || 0,
      cash_paid: cashPaid,
      bank_paid: bankPaid,
      cash_remaining: (parseFloat(farmer.cash_amount) || 0) - cashPaid,
      bank_remaining: (parseFloat(farmer.bank_amount) || 0) - bankPaid,
    },
    entryVisibility,
  });
});

/**
 * PUT /farmers/:farmerId/payments/:paymentId
 * Update a payment
 */
export const updatePayment = asyncHandler(async (req, res) => {
  const farmerId = parseInt(req.params.farmerId);
  const paymentId = parseInt(req.params.paymentId);
  if (!Number.isInteger(farmerId) || farmerId <= 0 || !Number.isInteger(paymentId) || paymentId <= 0) {
    return res.status(400).json({ message: 'A valid farmer and payment id are required' });
  }
  const entryVisibility = await resolveEntryVisibility(req.user, 'farmers', null);
  const {
    cheque_no, assigned_admin_id,
    date, particular, amount, by_note, remarks,
    payment_mode, cash_amount, bank_amount, bank_name, bank_account_no, bank_reference, bank_ifsc,
    voucher_url,
  } = req.body;

  const requestedFields = {
    date, particular, amount, by_note, remarks,
    payment_mode, cash_amount, bank_amount, bank_name, bank_account_no,
    bank_reference, bank_ifsc, voucher_url, cheque_no, assigned_admin_id,
    transaction_type: req.body.transaction_type,
  };
  const hasRequestedUpdate = Object.values(requestedFields).some((value) => value !== undefined);
  if (!hasRequestedUpdate) {
    return res.status(400).json({ message: 'Nothing to update' });
  }

  const client = await pool.connect();
  let transactionStarted = false;
  try {
    await client.query('BEGIN');
    transactionStarted = true;

    const lockedResult = await client.query(
      `SELECT fp.*, f.site_id
         FROM farmer_payments fp
         JOIN farmers f ON f.id = fp.farmer_id
        WHERE fp.id = $1
          AND fp.farmer_id = $2
          AND ($3::int IS NULL OR fp.created_by = $3::int)
        FOR UPDATE OF fp`,
      [paymentId, farmerId, entryVisibility.creatorId]
    );
    const existing = lockedResult.rows[0];
    if (!existing) {
      await client.query('ROLLBACK');
      transactionStarted = false;
      return res.status(404).json({ message: 'Payment not found' });
    }

    const updateData = {};
    if (date !== undefined) updateData.date = date;
    if (particular !== undefined) updateData.particular = particular;
    if (by_note !== undefined) updateData.by_note = by_note;
    if (remarks !== undefined) updateData.remarks = remarks;
    if (bank_name !== undefined) updateData.bank_name = bank_name;
    if (bank_account_no !== undefined) updateData.bank_account_no = bank_account_no;
    if (bank_reference !== undefined) updateData.bank_reference = bank_reference;
    if (bank_ifsc !== undefined) updateData.bank_ifsc = bank_ifsc;
    if (voucher_url !== undefined) updateData.voucher_url = voucher_url || null;
    if (cheque_no !== undefined) updateData.cheque_no = cheque_no ? String(cheque_no).trim() : null;
    if (assigned_admin_id !== undefined) {
      updateData.assigned_admin_id = assigned_admin_id ? parseInt(assigned_admin_id) : null;
    }

    const tupleTouched = farmerPaymentFieldsTouched(req.body);
    let effectiveMode = String(existing.payment_mode || 'CASH').trim().toUpperCase();
    if (tupleTouched) {
      let normalized;
      try {
        normalized = normalizeFarmerPaymentInput(req.body, existing);
      } catch (error) {
        if (error instanceof FarmerPaymentValidationError) {
          await client.query('ROLLBACK');
          transactionStarted = false;
          return res.status(400).json({ code: error.code, message: error.message });
        }
        throw error;
      }
      Object.assign(updateData, normalized);
      effectiveMode = normalized.payment_mode;
    }

    // Every direct edit returns to approval. The universal trigger converts an
    // old posting into a reservation in the same transaction.
    updateData.status = 'pending';
    updateData.approved_by = null;
    updateData.approved_at = null;
    if (tupleTouched || cheque_no !== undefined) {
      updateData.cheque_status = effectiveMode === 'CHEQUE' ? 'PENDING' : null;
    }

    const keys = Object.keys(updateData);
    const setClause = keys.map((key, index) => `${key} = $${index + 1}`).join(', ');
    const result = await client.query(
      `UPDATE farmer_payments
          SET ${setClause}, updated_at = NOW()
        WHERE id = $${keys.length + 1}
        RETURNING *`,
      [...Object.values(updateData), paymentId]
    );
    const updated = result.rows[0];

    // Delete stale 1/2-leg mirrors and recreate them from the now-canonical
    // owner while both operations share this transaction.
    const daybookEntries = await rebuildFarmerPaymentDayBook(client, paymentId);

    if (existing.status === 'approved') {
      await reverseApprovedImprestDebit({
        createdBy: existing.created_by,
        referenceId: existing.id,
        sourceModule: 'farmer_payment',
        siteId: existing.site_id,
      }, client);
    }

    await client.query('COMMIT');
    transactionStarted = false;
    return res.json({ payment: updated, daybook_entries: daybookEntries });
  } catch (error) {
    if (transactionStarted) await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
});

/**
 * DELETE /farmers/:farmerId/payments/:paymentId
 * Delete a payment
 */
export const deletePayment = asyncHandler(async (req, res) => {
  const farmerId = parseInt(req.params.farmerId);
  const paymentId = parseInt(req.params.paymentId);
  const entryVisibility = await resolveEntryVisibility(req.user, 'farmers', null);

  // Single round-trip: cascade-delete the linked DayBook rows AND the payment
  // in one atomic statement (CTE). Previously: SELECT + DELETE day_book +
  // DELETE payment = 3 serial round-trips.
  const result = await pool.query(
    `WITH visible_payment AS (
       SELECT id FROM farmer_payments
        WHERE id = $1 AND farmer_id = $2
          AND ($3::int IS NULL OR created_by = $3::int)
     ), del_daybook AS (
       DELETE FROM day_book WHERE farmer_payment_id IN (SELECT id FROM visible_payment)
     )
     DELETE FROM farmer_payments
      WHERE id IN (SELECT id FROM visible_payment)
      RETURNING id`,
    [paymentId, farmerId, entryVisibility.creatorId]
  );
  if (!result.rows[0]) {
    return res.status(404).json({ message: 'Payment not found' });
  }
  res.json({ message: 'Payment deleted' });
});

/**
 * POST /farmers/:farmerId/payments/bulk-delete
 * Body: { ids: number[] }
 */
export const bulkDeletePayments = asyncHandler(async (req, res) => {
  const farmerId = parseInt(req.params.farmerId);
  const ids = Array.isArray(req.body.ids) ? req.body.ids.map((id) => parseInt(id)).filter(Number.isInteger) : [];
  if (ids.length === 0) return res.status(400).json({ message: 'ids array is required' });
  const entryVisibility = await resolveEntryVisibility(req.user, 'farmers', null);

  const result = await pool.query(
    `WITH visible_payments AS (
       SELECT id FROM farmer_payments
        WHERE id = ANY($1::int[]) AND farmer_id = $2
          AND ($3::int IS NULL OR created_by = $3::int)
     ), del_daybook AS (
       DELETE FROM day_book WHERE farmer_payment_id IN (SELECT id FROM visible_payments)
     )
     DELETE FROM farmer_payments
      WHERE id IN (SELECT id FROM visible_payments)
      RETURNING id`,
    [ids, farmerId, entryVisibility.creatorId]
  );
  res.json({ message: `${result.rows.length} payment(s) deleted`, deleted: result.rows.map((r) => r.id) });
});

// ──────────────────────────────────────────────────────────────
// FARMER MEMBERS (for Register Farmer dropdown)
// ──────────────────────────────────────────────────────────────

/**
 * GET /farmers/members?site_id=X
 * List all registered members for farmer registration dropdown
 */
export const listFarmerMembers = asyncHandler(async (req, res) => {
  const { site_id } = req.query;
  if (!site_id) return res.status(400).json({ message: 'site_id is required' });

  const result = await pool.query(
    `SELECT id, full_name, phone, address, bank_name, branch AS bank_branch, account_no AS bank_account_no, ifsc_code AS bank_ifsc, member_type
     FROM members
     WHERE site_id = $1
     ORDER BY full_name ASC`,
    [parseInt(site_id)]
  );

  res.json({ members: result.rows });
});

// ──────────────────────────────────────────────────────────────
// PUBLIC RECEIPT VERIFY
// ──────────────────────────────────────────────────────────────

/**
 * GET /farmers/verify-receipt?token=...
 * Public endpoint — verifies an HMAC-signed farmer payment receipt token.
 */
export const verifyFarmerReceipt = (req, res) => {
  const result = verifyReceiptToken(req.query?.token);
  if (!result.valid) {
    return res.status(400).json({ valid: false, message: result.reason });
  }
  return res.json({ valid: true, receipt: result.payload });
};
