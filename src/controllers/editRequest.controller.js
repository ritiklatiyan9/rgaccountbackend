import asyncHandler from '../utils/asyncHandler.js';
import { editRequestModel } from '../models/EditRequest.model.js';
import { farmerModel, farmerPaymentModel } from '../models/Farmer.model.js';
import { plotModel, plotPaymentModel } from '../models/Plot.model.js';
import { dayBookModel } from '../models/DayBook.model.js';
import { expenseModel } from '../models/Expense.model.js';
import { plotCommissionModel } from '../models/PlotCommission.model.js';
import { cashFlowEntryModel } from '../models/CashFlow.model.js';
import { firmTransactionModel } from '../models/Firm.model.js';
import { uploadToCloudinary } from '../utils/cloudinary.js';
import { cleanupFile } from '../middlewares/multer.middleware.js';
import { createRegistryRecord } from './registry.controller.js';
import pool from '../config/db.js';

// Map module name to { model, fetchOriginal }
const MODULE_MAP = {
  // Create-type request: a sub-admin wants a registry while the plot's bank
  // payments are not yet clear. record_id = plot_id (dedupes to one pending
  // request per plot); proposed_data = the full POST /registries payload.
  // Approval runs the real create, attributed to the original requester.
  plot_registry_create: {
    model: plotModel,
    fetchOriginal: async (id) => plotModel.findById(parseInt(id), pool),
    // Reject guaranteed-to-fail requests up-front instead of parking them in
    // the admin queue. Returns an error message or null.
    validateCreate: async (data, user) => {
      if (user.role !== 'admin' && user.role !== 'super_admin' && user.role !== 'sub_admin') {
        return 'Not allowed to request a registry';
      }
      const total = (Array.isArray(data?.payments) ? data.payments : [])
        .reduce((n, p) => n + (parseFloat(p?.amount) || (p?.source_plot_payment_id ? 1 : 0)), 0);
      if (total <= 0) {
        return 'Map at least one payment before requesting a registry — a registry cannot be created without money mapped to it';
      }
      if (data?.site_id && data?.plot_no) {
        const { rows } = await pool.query(
          `SELECT 1 FROM plot_registries WHERE site_id = $1 AND UPPER(plot_no) = UPPER($2) LIMIT 1`,
          [parseInt(data.site_id), String(data.plot_no).trim()]
        );
        if (rows.length) return `Registry for plot "${data.plot_no}" already exists`;
      }
      return null;
    },
    applyUpdate: async (id, data, editReq) => {
      const out = await createRegistryRecord(data, editReq?.requested_by || null);
      if (out.status >= 400) throw new Error(out.body?.message || 'Failed to create registry');
      return out.body;
    },
  },
  farmer: {
    model: farmerModel,
    fetchOriginal: async (id) => farmerModel.findById(parseInt(id), pool),
    applyUpdate: async (id, data) => {
      // farmers table columns: name, phone, address, total_amount, interest_rate, notes, status
      const allowed = {};
      if (data.name !== undefined) allowed.name = data.name;
      if (data.phone !== undefined) allowed.phone = data.phone;
      if (data.address !== undefined) allowed.address = data.address;
      if (data.total_amount !== undefined) allowed.total_amount = data.total_amount;
      if (data.interest_rate !== undefined) allowed.interest_rate = data.interest_rate;
      if (data.notes !== undefined) allowed.notes = data.notes;
      if (data.status !== undefined) allowed.status = data.status;
      if (Object.keys(allowed).length > 0) {
        return farmerModel.update(parseInt(id), allowed, pool);
      }
    },
  },
  farmer_payment: {
    model: farmerPaymentModel,
    fetchOriginal: async (id) => farmerPaymentModel.findById(parseInt(id), pool),
    applyUpdate: async (id, data) => {
      // farmer_payments columns: date, particular, amount, by_note, interest_rate, interest_amount, remarks, farmer_id
      const allowed = {};
      if (data.date !== undefined) allowed.date = data.date;
      if (data.particular !== undefined) allowed.particular = data.particular;
      if (data.amount !== undefined) allowed.amount = data.amount;
      if (data.by_note !== undefined) allowed.by_note = data.by_note;
      if (data.interest_rate !== undefined) allowed.interest_rate = data.interest_rate;
      if (data.interest_amount !== undefined) allowed.interest_amount = data.interest_amount;
      if (data.remarks !== undefined) allowed.remarks = data.remarks;
      if (data.farmer_id !== undefined) allowed.farmer_id = data.farmer_id;
      if (Object.keys(allowed).length > 0) {
        return farmerPaymentModel.update(parseInt(id), allowed, pool);
      }
    },
  },
  plot: {
    model: plotModel,
    fetchOriginal: async (id) => plotModel.findById(parseInt(id), pool),
    applyUpdate: async (id, data) => {
      // plots columns: plot_no, block, buyer_name, plot_size, plot_rate, sale_price, registry_area, circle_rate, to_receive_bank, first_installment, booking_by, booking_date, status, notes
      const allowed = {};
      for (const key of ['plot_no', 'block', 'buyer_name', 'plot_size', 'plot_rate', 'sale_price', 'registry_area', 'circle_rate', 'to_receive_bank', 'first_installment', 'booking_by', 'booking_date', 'status', 'notes']) {
        if (data[key] !== undefined) allowed[key] = data[key];
      }
      if (Object.keys(allowed).length > 0) {
        return plotModel.update(parseInt(id), allowed, pool);
      }
    },
  },
  plot_payment: {
    model: plotPaymentModel,
    fetchOriginal: async (id) => plotPaymentModel.findById(parseInt(id), pool),
    applyUpdate: async (id, data) => {
      // plot_payments columns: date, payment_from, payment_type, bank_details, narration, received_by, amount, plot_id
      const allowed = {};
      if (data.date !== undefined) allowed.date = data.date;
      if (data.payment_from !== undefined) allowed.payment_from = data.payment_from;
      if (data.payment_type !== undefined) allowed.payment_type = data.payment_type;
      if (data.bank_details !== undefined) allowed.bank_details = data.bank_details;
      if (data.narration !== undefined) allowed.narration = data.narration;
      if (data.received_by !== undefined) allowed.received_by = data.received_by;
      if (data.amount !== undefined) allowed.amount = data.amount;
      if (data.plot_id !== undefined) allowed.plot_id = data.plot_id;
      if (Object.keys(allowed).length > 0) {
        return plotPaymentModel.update(parseInt(id), allowed, pool);
      }
    },
  },
  daybook: {
    model: dayBookModel,
    fetchOriginal: async (id) => dayBookModel.findById(parseInt(id), pool),
    applyUpdate: async (id, data) => {
      // day_book columns: date, particular, entry_type, debit, credit, remarks, payment_mode, category, from_entity, to_entity, account_no, branch
      const allowed = {};
      for (const key of ['date', 'particular', 'entry_type', 'debit', 'credit', 'remarks', 'payment_mode', 'category', 'from_entity', 'to_entity', 'account_no', 'branch']) {
        if (data[key] !== undefined) allowed[key] = data[key];
      }
      if (Object.keys(allowed).length > 0) {
        return dayBookModel.update(parseInt(id), allowed, pool);
      }
    },
  },
  daybook_expense: {
    model: expenseModel,
    fetchOriginal: async (id) => expenseModel.findById(parseInt(id), pool),
    applyUpdate: async (id, data) => {
      // expenses columns: date, from_entity, to_entity, payment_mode, debit, credit, remark, account_no, branch, category
      const allowed = {};
      if (data.date !== undefined) allowed.date = data.date;
      if (data.from_entity !== undefined) allowed.from_entity = data.from_entity;
      if (data.to_entity !== undefined) allowed.to_entity = data.to_entity;
      if (data.payment_mode !== undefined) allowed.payment_mode = data.payment_mode;
      if (data.debit !== undefined) allowed.debit = data.debit;
      if (data.credit !== undefined) allowed.credit = data.credit;
      if (data.remarks !== undefined) allowed.remark = data.remarks; // daybook uses 'remarks', expenses uses 'remark'
      if (data.remark !== undefined) allowed.remark = data.remark;
      if (data.account_no !== undefined) allowed.account_no = data.account_no;
      if (data.branch !== undefined) allowed.branch = data.branch;
      if (data.category !== undefined) allowed.category = data.category;
      if (Object.keys(allowed).length > 0) {
        return expenseModel.update(parseInt(id), allowed, pool);
      }
    },
  },
  daybook_farmer_payment: {
    model: farmerPaymentModel,
    fetchOriginal: async (id) => farmerPaymentModel.findById(parseInt(id), pool),
    applyUpdate: async (id, data) => {
      // Map daybook form fields → farmer_payments columns
      const fpUpdate = {};
      if (data.date !== undefined) fpUpdate.date = data.date;
      if (data.payment_mode !== undefined) fpUpdate.particular = data.payment_mode; // daybook payment_mode → fp particular
      if (data.particular !== undefined && !data.payment_mode) fpUpdate.particular = data.particular;
      if (data.debit !== undefined) fpUpdate.amount = parseFloat(data.debit) || 0; // daybook debit → fp amount
      if (data.by_note !== undefined) fpUpdate.by_note = data.by_note;
      if (data.farmer_id !== undefined) fpUpdate.farmer_id = data.farmer_id;
      if (data.interest_rate !== undefined) fpUpdate.interest_rate = parseFloat(data.interest_rate) || 0;
      if (data.interest_amount !== undefined) fpUpdate.interest_amount = parseFloat(data.interest_amount) || 0;
      if (data.remarks !== undefined) fpUpdate.remarks = data.remarks;

      if (Object.keys(fpUpdate).length > 0) {
        await farmerPaymentModel.update(parseInt(id), fpUpdate, pool);
      }

      // Sync linked daybook entry
      const linkedDb = await pool.query('SELECT id FROM day_book WHERE farmer_payment_id = $1', [parseInt(id)]);
      if (linkedDb.rows.length > 0) {
        const dbUpdate = {};
        for (const key of ['date', 'particular', 'entry_type', 'debit', 'credit', 'remarks', 'payment_mode', 'category', 'from_entity', 'to_entity', 'account_no', 'branch']) {
          if (data[key] !== undefined) dbUpdate[key] = data[key];
        }
        if (Object.keys(dbUpdate).length > 0) {
          await dayBookModel.update(linkedDb.rows[0].id, dbUpdate, pool);
        }
      }
    },
  },
  daybook_commission: {
    model: plotCommissionModel,
    fetchOriginal: async (id) => plotCommissionModel.findById(parseInt(id), pool),
    applyUpdate: async (id, data) => {
      // Map daybook form fields → plot_commissions columns
      const pcUpdate = {};
      if (data.date !== undefined) pcUpdate.date = data.date;
      if (data.particular !== undefined) pcUpdate.particular = data.particular;
      if (data.father_name !== undefined) pcUpdate.father_name = data.father_name;
      if (data.plot_no !== undefined) pcUpdate.plot_no = data.plot_no;
      if (data.plot_size !== undefined) pcUpdate.plot_size = data.plot_size;
      if (data.plot_rate !== undefined) pcUpdate.plot_rate = data.plot_rate;
      if (data.debit !== undefined) pcUpdate.amount = parseFloat(data.debit) || 0;
      if (data.by_note !== undefined) pcUpdate.by_note = data.by_note;
      if (data.remarks !== undefined) pcUpdate.remarks = data.remarks;

      if (Object.keys(pcUpdate).length > 0) {
        await plotCommissionModel.update(parseInt(id), pcUpdate, pool);
      }

      // Sync linked daybook entry
      const linkedDb = await pool.query('SELECT id FROM day_book WHERE commission_id = $1', [parseInt(id)]);
      if (linkedDb.rows.length > 0) {
        const dbUpdate = {};
        for (const key of ['date', 'particular', 'entry_type', 'debit', 'credit', 'remarks', 'payment_mode', 'category', 'from_entity', 'to_entity', 'account_no', 'branch']) {
          if (data[key] !== undefined) dbUpdate[key] = data[key];
        }
        if (Object.keys(dbUpdate).length > 0) {
          await dayBookModel.update(linkedDb.rows[0].id, dbUpdate, pool);
        }
      }
    },
  },
  daybook_cashflow: {
    model: cashFlowEntryModel,
    fetchOriginal: async (id) => cashFlowEntryModel.findById(parseInt(id), pool),
    applyUpdate: async (id, data) => {
      // Map daybook form fields → cash_flow_entries columns
      const cfUpdate = {};
      if (data.date !== undefined) cfUpdate.date = data.date;
      if (data.particular !== undefined) cfUpdate.particular = data.particular;
      if (data.debit !== undefined) cfUpdate.debit = parseFloat(data.debit) || 0;
      if (data.credit !== undefined) cfUpdate.credit = parseFloat(data.credit) || 0;
      if (data.remarks !== undefined) cfUpdate.remarks = data.remarks;

      if (Object.keys(cfUpdate).length > 0) {
        await cashFlowEntryModel.update(parseInt(id), cfUpdate, pool);
      }

      // Sync linked daybook entry
      const linkedDb = await pool.query('SELECT id FROM day_book WHERE cash_flow_entry_id = $1', [parseInt(id)]);
      if (linkedDb.rows.length > 0) {
        const dbUpdate = {};
        for (const key of ['date', 'particular', 'entry_type', 'debit', 'credit', 'remarks', 'payment_mode', 'category', 'from_entity', 'to_entity', 'account_no', 'branch']) {
          if (data[key] !== undefined) dbUpdate[key] = data[key];
        }
        if (Object.keys(dbUpdate).length > 0) {
          await dayBookModel.update(linkedDb.rows[0].id, dbUpdate, pool);
        }
      }
    },
  },
  daybook_firm_transaction: {
    model: firmTransactionModel,
    fetchOriginal: async (id) => firmTransactionModel.findById(parseInt(id), pool),
    applyUpdate: async (id, data) => {
      // Map daybook form fields → firm_transactions columns
      const ftUpdate = {};
      if (data.date !== undefined) ftUpdate.date = data.date;
      if (data.particular !== undefined) ftUpdate.description = data.particular; // daybook particular → ft description
      if (data.debit !== undefined) ftUpdate.debit = parseFloat(data.debit) || 0;
      if (data.credit !== undefined) ftUpdate.credit = parseFloat(data.credit) || 0;
      if (data.firm_name !== undefined) ftUpdate.name = data.firm_name;
      if (data.firm_purpose !== undefined) ftUpdate.purpose = data.firm_purpose;
      if (data.firm_remark !== undefined) ftUpdate.remark = data.firm_remark;
      if (data.firm_cheque_no !== undefined) ftUpdate.cheque_no = data.firm_cheque_no;

      if (Object.keys(ftUpdate).length > 0) {
        await firmTransactionModel.update(parseInt(id), ftUpdate, pool);
      }

      // Sync linked daybook entry
      const linkedDb = await pool.query('SELECT id FROM day_book WHERE firm_transaction_id = $1', [parseInt(id)]);
      if (linkedDb.rows.length > 0) {
        const dbUpdate = {};
        for (const key of ['date', 'particular', 'entry_type', 'debit', 'credit', 'remarks', 'payment_mode', 'category', 'from_entity', 'to_entity', 'account_no', 'branch']) {
          if (data[key] !== undefined) dbUpdate[key] = data[key];
        }
        if (Object.keys(dbUpdate).length > 0) {
          await dayBookModel.update(linkedDb.rows[0].id, dbUpdate, pool);
        }
      }
    },
  },
  daybook_plot_payment: {
    model: plotPaymentModel,
    fetchOriginal: async (id) => plotPaymentModel.findById(parseInt(id), pool),
    applyUpdate: async (id, data) => {
      // Map daybook form fields → plot_payments columns
      const ppUpdate = {};
      if (data.date !== undefined) ppUpdate.date = data.date;
      if (data.pp_payment_from !== undefined) ppUpdate.payment_from = data.pp_payment_from;
      if (data.pp_payment_type !== undefined) ppUpdate.payment_type = data.pp_payment_type;
      if (data.pp_bank_details !== undefined) ppUpdate.bank_details = data.pp_bank_details;
      if (data.pp_narration !== undefined) ppUpdate.narration = data.pp_narration;
      if (data.pp_received_by !== undefined) ppUpdate.received_by = data.pp_received_by;
      // For plot payments, the amount comes from credit (received) or debit (refund)
      if (data.credit !== undefined && parseFloat(data.credit) > 0) ppUpdate.amount = parseFloat(data.credit);
      else if (data.debit !== undefined && parseFloat(data.debit) > 0) ppUpdate.amount = -(parseFloat(data.debit));

      if (Object.keys(ppUpdate).length > 0) {
        await plotPaymentModel.update(parseInt(id), ppUpdate, pool);
      }

      // Sync linked daybook entry
      const linkedDb = await pool.query('SELECT id FROM day_book WHERE plot_payment_id = $1', [parseInt(id)]);
      if (linkedDb.rows.length > 0) {
        const dbUpdate = {};
        for (const key of ['date', 'particular', 'entry_type', 'debit', 'credit', 'remarks', 'payment_mode', 'category', 'from_entity', 'to_entity', 'account_no', 'branch']) {
          if (data[key] !== undefined) dbUpdate[key] = data[key];
        }
        if (Object.keys(dbUpdate).length > 0) {
          await dayBookModel.update(linkedDb.rows[0].id, dbUpdate, pool);
        }
      }
    },
  },
};

// ══════════════════════════════════════════════════
//  CREATE EDIT REQUEST (sub-admin)
// ══════════════════════════════════════════════════

/**
 * POST /edit-requests
 * Sub-admin submits an edit request with proof photo
 */
export const createEditRequest = asyncHandler(async (req, res) => {
  const { module, record_id, proposed_data, site_id } = req.body;

  if (!module || !record_id) {
    return res.status(400).json({ message: 'Module and record_id are required' });
  }

  if (!MODULE_MAP[module]) {
    return res.status(400).json({ message: `Invalid module: ${module}` });
  }

  // Check for existing pending request
  const existing = await editRequestModel.findPendingForRecord(module, record_id, pool);
  if (existing) {
    return res.status(409).json({ message: 'There is already a pending edit request for this record' });
  }

  // Fetch original data
  const handler = MODULE_MAP[module];
  const originalRecord = await handler.fetchOriginal(record_id);
  if (!originalRecord) {
    return res.status(404).json({ message: 'Record not found' });
  }

  // Upload proof photo if provided
  let proofPhotoUrl = null;
  if (req.file) {
    proofPhotoUrl = await uploadToCloudinary(req.file.path, 'edit-proofs');
    cleanupFile(req.file.path);
  }

  // Parse proposed_data if it's a string
  let parsedProposed = proposed_data;
  if (typeof proposed_data === 'string') {
    try {
      parsedProposed = JSON.parse(proposed_data);
    } catch {
      return res.status(400).json({ message: 'Invalid proposed_data JSON' });
    }
  }

  // Module-specific up-front validation (create-type requests) — don't park
  // requests in the admin queue that approval is guaranteed to reject.
  if (handler.validateCreate) {
    const invalid = await handler.validateCreate(parsedProposed, req.user);
    if (invalid) return res.status(400).json({ message: invalid });
  }

  const editRequest = await editRequestModel.create({
    requested_by: req.user.id,
    site_id: site_id ? parseInt(site_id) : null,
    module,
    record_id: parseInt(record_id),
    original_data: JSON.stringify(originalRecord),
    proposed_data: JSON.stringify(parsedProposed || {}),
    proof_photo_url: proofPhotoUrl,
    status: 'pending',
  }, pool);

  res.status(201).json({ editRequest, message: 'Edit request submitted for admin approval' });
});

// ══════════════════════════════════════════════════
//  LIST EDIT REQUESTS (admin or requester)
// ══════════════════════════════════════════════════

/**
 * GET /edit-requests?status=pending&site_id=X
 */
export const listEditRequests = asyncHandler(async (req, res) => {
  const { status, site_id } = req.query;

  let requests;
  if (status) {
    requests = await editRequestModel.findByStatus(status, pool, site_id || null);
  } else {
    requests = await editRequestModel.findPending(pool, site_id || null);
  }

  res.json({ requests });
});

/**
 * GET /edit-requests/my-requests
 * Sub-admin views their own requests
 */
export const listMyEditRequests = asyncHandler(async (req, res) => {
  const requests = await editRequestModel.findByRequester(req.user.id, pool);
  res.json({ requests });
});

/**
 * GET /edit-requests/counts?site_id=X
 * Get status counts for badge display
 */
export const getEditRequestCounts = asyncHandler(async (req, res) => {
  const { site_id } = req.query;
  const counts = await editRequestModel.getStatusCounts(pool, site_id || null);
  res.json(counts);
});

// ══════════════════════════════════════════════════
//  APPROVE EDIT REQUEST (admin)
// ══════════════════════════════════════════════════

/**
 * PUT /edit-requests/:id/approve
 * Admin approves an edit request — applies the proposed changes
 */
export const approveEditRequest = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const editReq = await editRequestModel.findById(parseInt(id), pool);
  
  if (!editReq) {
    return res.status(404).json({ message: 'Edit request not found' });
  }
  if (editReq.status !== 'pending') {
    return res.status(400).json({ message: `Edit request is already ${editReq.status}` });
  }

  const handler = MODULE_MAP[editReq.module];
  if (!handler) {
    return res.status(400).json({ message: `Unknown module: ${editReq.module}` });
  }

  // Upload admin review photo if provided
  let reviewPhotoUrl = null;
  if (req.file) {
    reviewPhotoUrl = await uploadToCloudinary(req.file.path, 'edit-review-proofs');
    cleanupFile(req.file.path);
  }

  // Apply the proposed changes to the actual record
  const proposedData = typeof editReq.proposed_data === 'string' 
    ? JSON.parse(editReq.proposed_data) 
    : editReq.proposed_data;

  // Remove any keys that shouldn't be updated directly
  delete proposedData.id;
  delete proposedData.created_at;
  delete proposedData.updated_at;
  delete proposedData.created_by;

  // Apply — a failure here (e.g. registry payments claimed elsewhere since
  // submission) must surface to the admin as a 400 with the real reason, and
  // the request stays pending so it can be fixed/rejected explicitly.
  let applied;
  try {
    applied = await handler.applyUpdate(editReq.record_id, proposedData, editReq);
  } catch (err) {
    return res.status(400).json({
      message: `Could not apply this request: ${err.message}`,
    });
  }

  // Mark the edit request as approved
  const updatePayload = {
    status: 'approved',
    reviewed_by: req.user.id,
    reviewed_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  if (reviewPhotoUrl) updatePayload.review_photo_url = reviewPhotoUrl;

  const updated = await editRequestModel.update(parseInt(id), updatePayload, pool);

  let message = 'Edit request approved and changes applied';
  if (applied?.payments_skipped > 0) {
    message += ` — note: ${applied.payments_skipped} linked payment(s) were no longer available and were skipped`;
  }
  res.json({ editRequest: updated, applied: applied ?? null, message });
});

// ══════════════════════════════════════════════════
//  REJECT EDIT REQUEST (admin)
// ══════════════════════════════════════════════════

/**
 * PUT /edit-requests/:id/reject
 * Admin rejects an edit request
 */
export const rejectEditRequest = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { rejection_reason } = req.body;

  const editReq = await editRequestModel.findById(parseInt(id), pool);
  
  if (!editReq) {
    return res.status(404).json({ message: 'Edit request not found' });
  }
  if (editReq.status !== 'pending') {
    return res.status(400).json({ message: `Edit request is already ${editReq.status}` });
  }

  const updated = await editRequestModel.update(parseInt(id), {
    status: 'rejected',
    reviewed_by: req.user.id,
    reviewed_at: new Date().toISOString(),
    rejection_reason: rejection_reason || null,
    updated_at: new Date().toISOString(),
  }, pool);

  res.json({ editRequest: updated, message: 'Edit request rejected' });
});
