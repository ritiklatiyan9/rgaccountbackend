import asyncHandler from '../utils/asyncHandler.js';
import { farmerModel, farmerPaymentModel } from '../models/Farmer.model.js';
import pool from '../config/db.js';

// ──────────────────────────────────────────────────────────────
// FARMER CRUD
// ──────────────────────────────────────────────────────────────

/**
 * POST /farmers
 * Create a new farmer (admin only)
 */
export const createFarmer = asyncHandler(async (req, res) => {
  const { name, phone, address, total_amount, interest_rate, site_id, notes, status } = req.body;

  if (!name) {
    return res.status(400).json({ message: 'Farmer name is required' });
  }
  if (!site_id) {
    return res.status(400).json({ message: 'Site is required' });
  }

  const farmerData = {
    name,
    phone: phone || null,
    address: address || null,
    total_amount: total_amount || 0,
    interest_rate: interest_rate || 0,
    site_id: parseInt(site_id),
    created_by: req.user.id,
    notes: notes || null,
    status: status || 'active',
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
  const { name, phone, address, total_amount, interest_rate, notes, status } = req.body;

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
 * Add a payment/installment to a farmer
 */
export const createPayment = asyncHandler(async (req, res) => {
  const { farmerId } = req.params;
  const { date, particular, amount, by_note, interest_rate, interest_amount, remarks } = req.body;

  const farmer = await farmerModel.findById(parseInt(farmerId), pool);
  if (!farmer) {
    return res.status(404).json({ message: 'Farmer not found' });
  }

  if (!particular) {
    return res.status(400).json({ message: 'Particular (payment method) is required' });
  }

  const paymentData = {
    farmer_id: parseInt(farmerId),
    date: date || new Date().toISOString().split('T')[0],
    particular,
    amount: amount || 0,
    by_note: by_note || null,
    interest_rate: interest_rate || 0,
    interest_amount: interest_amount || 0,
    remarks: remarks || null,
  };

  const payment = await farmerPaymentModel.create(paymentData, pool);
  res.status(201).json({ payment });
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

  res.json({
    farmer,
    payments,
    summary: {
      total_amount: parseFloat(farmer.total_amount),
      total_paid: totalPaid,
      total_interest: totalInterest,
      remaining: parseFloat(farmer.total_amount) - totalPaid,
    },
  });
});

/**
 * PUT /farmers/:farmerId/payments/:paymentId
 * Update a payment
 */
export const updatePayment = asyncHandler(async (req, res) => {
  const { farmerId, paymentId } = req.params;
  const { date, particular, amount, by_note, interest_rate, interest_amount, remarks } = req.body;

  const payment = await farmerPaymentModel.findById(parseInt(paymentId), pool);
  if (!payment || payment.farmer_id !== parseInt(farmerId)) {
    return res.status(404).json({ message: 'Payment not found' });
  }

  const updateData = {};
  if (date !== undefined) updateData.date = date;
  if (particular !== undefined) updateData.particular = particular;
  if (amount !== undefined) updateData.amount = amount;
  if (by_note !== undefined) updateData.by_note = by_note;
  if (interest_rate !== undefined) updateData.interest_rate = interest_rate;
  if (interest_amount !== undefined) updateData.interest_amount = interest_amount;
  if (remarks !== undefined) updateData.remarks = remarks;

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

  await farmerPaymentModel.delete(parseInt(paymentId), pool);
  res.json({ message: 'Payment deleted' });
});
