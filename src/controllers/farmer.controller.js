import crypto from 'crypto';
import asyncHandler from '../utils/asyncHandler.js';
import { farmerModel, farmerPaymentModel } from '../models/Farmer.model.js';
import { dayBookModel } from '../models/DayBook.model.js';
import pool from '../config/db.js';

// Public-facing verify page URL. QR on the printed receipt links here so a
// scanner lands on a human-friendly page (not raw API JSON).
// Override via env: PUBLIC_VERIFY_URL=https://www.your-site.com/verify-receipt
const PUBLIC_VERIFY_URL =
  process.env.PUBLIC_VERIFY_URL || 'http://localhost:5173/verify-receipt';

const signReceiptToken = (payment, farmer) => {
  const payload = {
    id: payment.id,
    farmer_id: payment.farmer_id,
    amount: payment.amount,
    date: payment.date,
    site_id: farmer.site_id,
    ts: Date.now(),
  };
  const sig = crypto
    .createHmac('sha256', process.env.RECEIPT_VERIFY_SECRET || '')
    .update(JSON.stringify(payload))
    .digest('hex');
  return Buffer.from(JSON.stringify({ payload, sig })).toString('base64url');
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
    land_size_bigha, land_rate, commission_percentage, commission_amount,
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
  const { id } = req.params;
  const {
    name, phone, address, total_amount, interest_rate, notes, status, member_id,
    payment_mode, cash_amount, bank_amount, bank_name, bank_account_no, bank_reference, bank_ifsc,
    land_size_bigha, land_rate, commission_percentage, commission_amount,
  } = req.body;

  const farmer = await farmerModel.findById(parseInt(id), pool);
  if (!farmer) {
    return res.status(404).json({ message: 'Farmer not found' });
  }

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
  if (land_rate !== undefined) updateData.land_rate = land_rate != null && land_rate !== '' ? parseFloat(land_rate) : null;
  if (commission_percentage !== undefined) updateData.commission_percentage = commission_percentage != null && commission_percentage !== '' ? parseFloat(commission_percentage) : null;
  if (commission_amount !== undefined) updateData.commission_amount = commission_amount != null && commission_amount !== '' ? parseFloat(commission_amount) : null;

  const updated = await farmerModel.update(parseInt(id), updateData, pool);
  res.json({ farmer: updated });
});

/**
 * DELETE /farmers/:id
 * Delete a farmer and all payments
 */
export const deleteFarmer = asyncHandler(async (req, res) => {
  const { id } = req.params;

  const farmer = await farmerModel.findById(parseInt(id), pool);
  if (!farmer) {
    return res.status(404).json({ message: 'Farmer not found' });
  }

  await farmerModel.delete(parseInt(id), pool);
  res.json({ message: 'Farmer deleted' });
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

  const farmer = await farmerModel.findById(parseInt(farmerId), pool);
  if (!farmer) {
    return res.status(404).json({ message: 'Farmer not found' });
  }

  if (!particular) {
    return res.status(400).json({ message: 'Particular (payment method) is required' });
  }

  const totalAmount = parseFloat(amount) || 0;
  const mode = (payment_mode || 'CASH').toUpperCase();
  const cashAmt = mode === 'BANK' || mode === 'CHEQUE' ? 0 : (mode === 'SPLIT' ? (parseFloat(cash_amount) || 0) : totalAmount);
  const bankAmt = mode === 'CASH' ? 0 : (mode === 'SPLIT' ? (parseFloat(bank_amount) || 0) : totalAmount);

  const paymentDate = date || new Date().toISOString().split('T')[0];

  const paymentData = {
    farmer_id: parseInt(farmerId),
    date: paymentDate,
    particular,
    amount: totalAmount,
    by_note: by_note || null,
    remarks: remarks || null,
    payment_mode: mode,
    cash_amount: cashAmt,
    bank_amount: bankAmt,
    bank_name: bank_name || null,
    bank_account_no: bank_account_no || null,
    bank_reference: bank_reference || null,
    bank_ifsc: bank_ifsc || null,
    voucher_url: voucher_url || null,
    assigned_admin_id: assigned_admin_id ? parseInt(assigned_admin_id) : null,
    status: 'pending',
    cheque_no: req.body.cheque_no ? String(req.body.cheque_no).trim() : null,
    cheque_status: mode === 'CHEQUE' ? 'PENDING' : null,
    created_by: req.user.id,
  };

  const payment = await farmerPaymentModel.create(paymentData, pool);

  // ── Auto-create DayBook entries ──
  const dayBookEntries = [];

  if (cashAmt > 0) {
    const cashEntry = await dayBookModel.create({
      site_id: farmer.site_id,
      date: paymentDate,
      particular: `${farmer.name} - FARMER PAYMENT (CASH)`.toUpperCase(),
      entry_type: 'FARMER PAYMENT',
      debit: cashAmt,
      credit: 0,
      remarks: remarks ? remarks.trim() : null,
      payment_mode: 'CASH',
      category: 'FARMER PAYMENT',
      from_entity: null,
      to_entity: farmer.name.toUpperCase(),
      created_by: req.user.id,
      assigned_admin_id: assigned_admin_id ? parseInt(assigned_admin_id) : null,
      farmer_payment_id: payment.id,
    }, pool);
    dayBookEntries.push(cashEntry);
  }

  if (bankAmt > 0) {
    const bankEntry = await dayBookModel.create({
      site_id: farmer.site_id,
      date: paymentDate,
      particular: `${farmer.name} - FARMER PAYMENT (BANK)`.toUpperCase(),
      entry_type: 'FARMER PAYMENT',
      debit: bankAmt,
      credit: 0,
      remarks: [remarks, bank_reference ? `Ref: ${bank_reference}` : null, bank_name ? `Bank: ${bank_name}` : null].filter(Boolean).join(' | ') || null,
      payment_mode: particular.toUpperCase(),
      category: 'FARMER PAYMENT',
      from_entity: bank_name ? bank_name.toUpperCase() : null,
      to_entity: farmer.name.toUpperCase(),
      account_no: bank_account_no || null,
      branch: bank_ifsc || null,
      created_by: req.user.id,
      assigned_admin_id: assigned_admin_id ? parseInt(assigned_admin_id) : null,
      farmer_payment_id: payment.id,
    }, pool);
    dayBookEntries.push(bankEntry);
  }

  res.status(201).json({ payment, daybook_entries: dayBookEntries });
});

/**
 * GET /farmers/:farmerId/payments
 * List all payments for a farmer
 */
export const listPayments = asyncHandler(async (req, res) => {
  const { farmerId } = req.params;

  const farmer = await farmerModel.findByIdWithSummary(parseInt(farmerId), pool);
  if (!farmer) {
    return res.status(404).json({ message: 'Farmer not found' });
  }

  const payments = await farmerPaymentModel.findByFarmerId(parseInt(farmerId), pool);
  const totalPaid = await farmerPaymentModel.getTotalPaid(parseInt(farmerId), pool);
  const totalInterest = await farmerPaymentModel.getTotalInterest(parseInt(farmerId), pool);

  // Cash/Bank paid totals from payments
  let cashPaid = 0, bankPaid = 0;
  for (const p of payments) {
    cashPaid += parseFloat(p.cash_amount) || 0;
    bankPaid += parseFloat(p.bank_amount) || 0;
  }

  const paymentsWithVerify = payments.map((p) => {
    const verifyToken = signReceiptToken(p, farmer);
    return {
      ...p,
      verifyToken,
      verifyUrl: `${PUBLIC_VERIFY_URL}?token=${verifyToken}`,
    };
  });

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
  });
});

/**
 * PUT /farmers/:farmerId/payments/:paymentId
 * Update a payment
 */
export const updatePayment = asyncHandler(async (req, res) => {
  const { farmerId, paymentId } = req.params;
  const {
    date, particular, amount, by_note, remarks,
    payment_mode, cash_amount, bank_amount, bank_name, bank_account_no, bank_reference, bank_ifsc,
    voucher_url,
  } = req.body;

  const payment = await farmerPaymentModel.findById(parseInt(paymentId), pool);
  if (!payment || payment.farmer_id !== parseInt(farmerId)) {
    return res.status(404).json({ message: 'Payment not found' });
  }

  const updateData = {};
  if (date !== undefined) updateData.date = date;
  if (particular !== undefined) updateData.particular = particular;
  if (amount !== undefined) updateData.amount = amount;
  if (by_note !== undefined) updateData.by_note = by_note;
  if (remarks !== undefined) updateData.remarks = remarks;
  if (payment_mode !== undefined) updateData.payment_mode = payment_mode;
  if (cash_amount !== undefined) updateData.cash_amount = cash_amount;
  if (bank_amount !== undefined) updateData.bank_amount = bank_amount;
  if (bank_name !== undefined) updateData.bank_name = bank_name;
  if (bank_account_no !== undefined) updateData.bank_account_no = bank_account_no;
  if (bank_reference !== undefined) updateData.bank_reference = bank_reference;
  if (bank_ifsc !== undefined) updateData.bank_ifsc = bank_ifsc;
  if (voucher_url !== undefined) updateData.voucher_url = voucher_url || null;

  const updated = await farmerPaymentModel.update(parseInt(paymentId), updateData, pool);
  res.json({ payment: updated });
});

/**
 * DELETE /farmers/:farmerId/payments/:paymentId
 * Delete a payment
 */
export const deletePayment = asyncHandler(async (req, res) => {
  const { farmerId, paymentId } = req.params;

  const payment = await farmerPaymentModel.findById(parseInt(paymentId), pool);
  if (!payment || payment.farmer_id !== parseInt(farmerId)) {
    return res.status(404).json({ message: 'Payment not found' });
  }

  // Delete linked DayBook entries
  try {
    await pool.query(`DELETE FROM day_book WHERE farmer_payment_id = $1`, [parseInt(paymentId)]);
  } catch (err) {
    console.error('[FarmerPayment] Failed to delete DayBook entries:', err.message);
  }

  await farmerPaymentModel.delete(parseInt(paymentId), pool);
  res.json({ message: 'Payment deleted' });
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
  try {
    const { token } = req.query;
    if (!token) {
      return res.status(400).json({ valid: false, message: 'Missing token' });
    }

    const decoded = JSON.parse(Buffer.from(String(token), 'base64url').toString('utf8'));
    const { payload, sig } = decoded || {};
    if (!payload || !sig) {
      return res.status(400).json({ valid: false, message: 'Malformed token' });
    }

    const expectedSig = crypto
      .createHmac('sha256', process.env.RECEIPT_VERIFY_SECRET || '')
      .update(JSON.stringify(payload))
      .digest('hex');

    const sigBuf = Buffer.from(sig, 'hex');
    const expBuf = Buffer.from(expectedSig, 'hex');
    if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
      return res.status(400).json({ valid: false, message: 'Invalid or tampered receipt' });
    }

    return res.json({ valid: true, receipt: payload });
  } catch (err) {
    return res.status(400).json({ valid: false, message: 'Malformed token' });
  }
};
