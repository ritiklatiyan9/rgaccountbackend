import asyncHandler from '../utils/asyncHandler.js';
import { memberModel } from '../models/Member.model.js';
import { uploadSingle } from '../utils/upload.js';
import pool from '../config/db.js';

// ── MEMBER FIELDS (whitelist) ──
const MEMBER_FIELDS = [
  'member_type', 'full_name', 'father_name', 'gender', 'date_of_birth', 'blood_group',
  'phone', 'alt_phone', 'email', 'whatsapp',
  'address', 'city', 'state', 'pincode',
  'aadhar_no', 'pan_no', 'voter_id',
  'bank_name', 'account_no', 'ifsc_code', 'branch',
  'occupation', 'company_name', 'reference', 'notes', 'status',
  // New personal fields
  'mother_name', 'spouse_name', 'nationality', 'religion', 'caste',
  'marital_status', 'anniversary_date', 'qualification',
  // Additional identity
  'passport_no', 'driving_license_no', 'gst_no', 'tin_no',
  // Emergency contact
  'emergency_contact_name', 'emergency_contact_phone', 'emergency_contact_relation',
  // Co-applicant (joint applicant)
  'co_applicant_name', 'co_applicant_relation', 'co_applicant_dob', 'co_applicant_gender',
  'co_applicant_phone', 'co_applicant_email', 'co_applicant_aadhar', 'co_applicant_pan',
  'co_applicant_address', 'permanent_address',
  // Nominee
  'nominee_name', 'nominee_relation', 'nominee_phone',
  // Employee-specific
  'employee_id', 'designation', 'department', 'date_of_joining', 'salary', 'employment_type',
  // Farmer-specific
  'land_area', 'crop_type', 'farm_location', 'irrigation_type', 'farming_experience',
  // Broker-specific
  'license_number', 'commission_rate', 'operating_areas',
  // Vendor-specific
  'business_name', 'service_type', 'payment_terms',
  // Team (for broker/member/employee/partner)
  'team',
];

const sanitize = (body) => {
  const data = {};
  MEMBER_FIELDS.forEach(f => {
    if (body[f] !== undefined) {
      let val = body[f];
      if (typeof val === 'string') val = val.trim();
      // Uppercase certain fields
      if (['full_name', 'father_name', 'member_type', 'gender', 'blood_group',
        'city', 'state', 'aadhar_no', 'pan_no', 'voter_id', 'ifsc_code',
        'occupation', 'company_name', 'reference', 'status',
        'mother_name', 'spouse_name', 'nationality', 'religion', 'caste',
        'marital_status', 'qualification', 'passport_no', 'driving_license_no',
        'gst_no', 'tin_no', 'emergency_contact_name', 'emergency_contact_relation',
        'nominee_name', 'nominee_relation', 'designation', 'department',
        'employment_type', 'team',
        'co_applicant_name', 'co_applicant_relation', 'co_applicant_gender',
        'co_applicant_aadhar', 'co_applicant_pan'].includes(f) && val) {
        val = val.toUpperCase();
      }
      data[f] = val || null;
    }
  });
  return data;
};

// Document field names that map to file upload keys
const DOC_FIELDS = [
  'photo', 'aadhar_front_url', 'aadhar_back_url', 'pan_card_url',
  'voter_id_url', 'passport_url', 'driving_license_url', 'cheque_url', 'other_kyc_url',
  'resume_url', 'marksheet_10th_url', 'marksheet_12th_url',
  'degree_certificate_url', 'experience_certificate_url',
  'offer_letter_url', 'other_certificate_url',
];

/** Upload all document files from req.files in PARALLEL and return a map of field→url */
const uploadDocuments = async (files) => {
  const urls = {};
  if (!files) return urls;

  const tasks = [];
  for (const fieldName of DOC_FIELDS) {
    const fileArr = files[fieldName];
    if (fileArr && fileArr.length > 0) {
      tasks.push(
        uploadSingle(fileArr[0], 'cloudinary')
          .then((url) => { urls[fieldName] = url; })
          .catch((err) => { console.error(`Upload failed for ${fieldName}:`, err?.message || err); })
      );
    }
  }
  if (tasks.length > 0) await Promise.all(tasks);
  return urls;
};

/** POST /members — Create a new member */
export const createMember = asyncHandler(async (req, res) => {
  const { site_id } = req.body;
  if (!site_id) return res.status(400).json({ message: 'Site is required' });

  const data = sanitize(req.body);
  if (!data.full_name) return res.status(400).json({ message: 'Full name is required' });

  data.site_id = parseInt(site_id);
  data.created_by = req.user.id;

  // Run phone uniqueness check + document uploads in PARALLEL
  const phoneCheckPromise = data.phone
    ? pool.query(
        `SELECT id, full_name FROM members WHERE site_id = $1 AND phone = $2 LIMIT 1`,
        [data.site_id, data.phone]
      )
    : Promise.resolve({ rows: [] });

  const [phoneCheck, docUrls] = await Promise.all([
    phoneCheckPromise,
    uploadDocuments(req.files),
  ]);

  if (phoneCheck.rows.length > 0) {
    return res.status(409).json({ message: `Phone number ${data.phone} is already registered to ${phoneCheck.rows[0].full_name}` });
  }

  Object.assign(data, docUrls);

  const member = await memberModel.create(data, pool);
  res.status(201).json({ member });
});

/** GET /members?site_id=X&type=CLIENT */
export const listMembers = asyncHandler(async (req, res) => {
  const { site_id, type } = req.query;
  if (!site_id) return res.status(400).json({ message: 'site_id is required' });

  const [members, summary] = await Promise.all([
    memberModel.findBySiteIdList(parseInt(site_id), pool, type || null),
    memberModel.getSummary(parseInt(site_id), pool),
  ]);
  res.json({ members, summary });
});

/** GET /members/search?site_id=X&q=... */
export const searchMembers = asyncHandler(async (req, res) => {
  const { site_id, q } = req.query;
  if (!site_id) return res.status(400).json({ message: 'site_id is required' });
  const members = await memberModel.search(parseInt(site_id), q || '', pool);
  res.json({ members });
});

/** GET /members/autocomplete?site_id=X */
export const getMemberAutocomplete = asyncHandler(async (req, res) => {
  const { site_id } = req.query;
  if (!site_id) return res.status(400).json({ message: 'site_id is required' });
  const data = await memberModel.getAutocomplete(parseInt(site_id), pool);
  res.json(data);
});

/** GET /members/:id */
export const getMember = asyncHandler(async (req, res) => {
  const member = await memberModel.findById(parseInt(req.params.id), pool);
  if (!member) return res.status(404).json({ message: 'Member not found' });
  res.json({ member });
});

/** PUT /members/:id */
export const updateMember = asyncHandler(async (req, res) => {
  const memberId = parseInt(req.params.id);

  // Run all 3 in PARALLEL: existence/site lookup, phone uniqueness, document uploads.
  // The phone check runs unconditionally (with `$2 IS NULL` guard) so we don't add a serial step.
  const data = sanitize(req.body);

  const existingPromise = pool.query(
    `SELECT id, site_id FROM members WHERE id = $1`,
    [memberId]
  );
  const phoneCheckPromise = data.phone
    ? pool.query(
        `SELECT m.id, m.full_name
           FROM members m
           JOIN members me ON me.id = $2
          WHERE m.site_id = me.site_id AND m.phone = $1 AND m.id != $2
          LIMIT 1`,
        [data.phone, memberId]
      )
    : Promise.resolve({ rows: [] });
  const docUploadPromise = uploadDocuments(req.files);

  const [existingRes, phoneCheck, docUrls] = await Promise.all([
    existingPromise,
    phoneCheckPromise,
    docUploadPromise,
  ]);

  const existing = existingRes.rows[0];
  if (!existing) return res.status(404).json({ message: 'Member not found' });

  if (phoneCheck.rows.length > 0) {
    return res.status(409).json({ message: `Phone number ${data.phone} is already registered to ${phoneCheck.rows[0].full_name}` });
  }

  Object.assign(data, docUrls);

  // Handle removing documents
  for (const field of DOC_FIELDS) {
    if (req.body[`remove_${field}`] === 'true') {
      data[field] = null;
    }
  }

  if (Object.keys(data).length === 0) return res.status(400).json({ message: 'Nothing to update' });

  const updated = await memberModel.update(memberId, data, pool);
  res.json({ member: updated });
});

/** DELETE /members/:id */
export const deleteMember = asyncHandler(async (req, res) => {
  const existing = await memberModel.findById(parseInt(req.params.id), pool);
  if (!existing) return res.status(404).json({ message: 'Member not found' });
  await memberModel.delete(parseInt(req.params.id), pool);
  res.json({ message: 'Member deleted' });
});

/** GET /members/:id/transactions?site_id=X */
export const getMemberTransactions = asyncHandler(async (req, res) => {
  const memberId = parseInt(req.params.id);
  const { site_id } = req.query;
  if (!site_id) return res.status(400).json({ message: 'site_id is required' });

  const member = await memberModel.findById(memberId, pool);
  if (!member) return res.status(404).json({ message: 'Member not found' });

  const siteId = parseInt(site_id);
  const memberName = member.full_name;

  // Fetch expenses linked by assigned_user_id OR by name match
  const expensesQuery = `
    SELECT e.id, e.date, e.from_entity, e.to_entity, e.payment_mode,
           e.debit, e.credit, e.remark, e.category, e.account_no, e.branch,
           e.voucher_url, e.status, e.created_at,
           'EXPENSE' as source
    FROM expenses e
    WHERE e.site_id = $1
      AND (e.assigned_user_id = $2 OR UPPER(e.to_entity) = UPPER($3) OR UPPER(e.from_entity) = UPPER($3))
    ORDER BY e.date DESC, e.id DESC
  `;

  // Fetch daybook entries linked by assigned_user_id OR by name match
  const daybookQuery = `
    SELECT d.id, d.date, d.from_entity, d.to_entity, d.payment_mode,
           d.debit, d.credit, d.remark, d.category, d.account_no, d.branch,
           d.entry_type, d.status, d.created_at,
           'DAYBOOK' as source
    FROM day_book d
    WHERE d.site_id = $1
      AND d.entry_type != 'EXPENSE'
      AND (d.assigned_user_id = $2 OR UPPER(d.to_entity) = UPPER($3) OR UPPER(d.from_entity) = UPPER($3))
    ORDER BY d.date DESC, d.id DESC
  `;

  const [expResult, dbResult] = await Promise.all([
    pool.query(expensesQuery, [siteId, memberId, memberName]),
    pool.query(daybookQuery, [siteId, memberId, memberName]),
  ]);

  const expenses = expResult.rows;
  const daybook = dbResult.rows;

  // Combine and sort by date DESC
  const all = [...expenses, ...daybook].sort((a, b) => {
    const da = new Date(a.date), db = new Date(b.date);
    return db - da || b.id - a.id;
  });

  // Summary
  const totalDebit = all.reduce((s, t) => s + (parseFloat(t.debit) || 0), 0);
  const totalCredit = all.reduce((s, t) => s + (parseFloat(t.credit) || 0), 0);

  res.json({
    transactions: all,
    summary: {
      total_debit: totalDebit,
      total_credit: totalCredit,
      net: totalCredit - totalDebit,
      count: all.length,
    },
  });
});

/** GET /members/:id/financial-info?site_id=X */
export const getMemberFinancialInfo = asyncHandler(async (req, res) => {
  const memberId = parseInt(req.params.id);
  const { site_id } = req.query;
  if (!site_id) return res.status(400).json({ message: 'site_id is required' });

  const member = await memberModel.findById(memberId, pool);
  if (!member) return res.status(404).json({ message: 'Member not found' });

  const siteId = parseInt(site_id);
  const memberName = member.full_name;

  // Run all queries in parallel using name matching + FK where available
  const [expRes, commRes, plotPayRes, farmerPayRes, firmRes] = await Promise.all([
    // 1. Expenses — by assigned_user_id or name match
    pool.query(
      `SELECT e.id, e.date, e.from_entity, e.to_entity, e.payment_mode,
              e.debit, e.credit, e.remark, e.category, e.status, e.voucher_url
       FROM expenses e
       WHERE e.site_id = $1
         AND (e.assigned_user_id = $2 OR UPPER(e.to_entity) = UPPER($3) OR UPPER(e.from_entity) = UPPER($3))
       ORDER BY e.date DESC, e.id DESC`,
      [siteId, memberId, memberName]
    ),
    // 2. Plot Commissions — by particular (person name)
    pool.query(
      `SELECT pc.id, pc.date, pc.particular, pc.amount, pc.plot_no, pc.plot_size,
              pc.by_note, pc.remarks, pc.status, pc.voucher_url
       FROM plot_commissions pc
       WHERE pc.site_id = $1 AND UPPER(pc.particular) = UPPER($2)
       ORDER BY pc.date DESC, pc.id DESC`,
      [siteId, memberName]
    ),
    // 3. Plot Payments — by payment_from (buyer name) or buyer_name on plot
    pool.query(
      `SELECT pp.id, pp.date, pp.amount, pp.payment_type, pp.bank_details,
              pp.narration, pp.payment_from, pp.received_by,
              p.plot_no, p.block, p.buyer_name
       FROM plot_payments pp
       JOIN plots p ON p.id = pp.plot_id
       WHERE pp.site_id = $1
         AND (UPPER(pp.payment_from) = UPPER($2) OR UPPER(p.buyer_name) = UPPER($2))
       ORDER BY pp.date DESC, pp.id DESC`,
      [siteId, memberName]
    ),
    // 4. Farmer Payments — via farmers.member_id
    pool.query(
      `SELECT fp.id, fp.date, fp.amount, fp.particular, fp.payment_mode,
              fp.cash_amount, fp.bank_amount, fp.remarks, fp.by_note,
              f.name AS farmer_name
       FROM farmer_payments fp
       JOIN farmers f ON f.id = fp.farmer_id
       WHERE f.site_id = $1 AND f.member_id = $2
       ORDER BY fp.date DESC, fp.id DESC`,
      [siteId, memberId]
    ),
    // 5. Firm Transactions — by name
    pool.query(
      `SELECT ft.id, ft.date, ft.debit, ft.credit, ft.description, ft.purpose,
              ft.remark, ft.cheque_no, ft.name,
              fi.name AS firm_name
       FROM firm_transactions ft
       JOIN firms fi ON fi.id = ft.firm_id
       WHERE fi.site_id = $1 AND UPPER(ft.name) = UPPER($2)
       ORDER BY ft.date DESC, ft.id DESC`,
      [siteId, memberName]
    ),
  ]);

  const expenses = expRes.rows;
  const commissions = commRes.rows;
  const plotPayments = plotPayRes.rows;
  const farmerPayments = farmerPayRes.rows;
  const firmTransactions = firmRes.rows;

  // Summaries per category
  const expTotal = expenses.reduce((s, e) => ({ debit: s.debit + (parseFloat(e.debit) || 0), credit: s.credit + (parseFloat(e.credit) || 0) }), { debit: 0, credit: 0 });
  const commTotal = commissions.reduce((s, c) => s + (parseFloat(c.amount) || 0), 0);
  const plotPayTotal = plotPayments.reduce((s, p) => s + (parseFloat(p.amount) || 0), 0);
  const farmerPayTotal = farmerPayments.reduce((s, p) => s + (parseFloat(p.amount) || 0), 0);
  const firmTotal = firmTransactions.reduce((s, f) => ({ debit: s.debit + (parseFloat(f.debit) || 0), credit: s.credit + (parseFloat(f.credit) || 0) }), { debit: 0, credit: 0 });

  res.json({
    expenses,
    commissions,
    plot_payments: plotPayments,
    farmer_payments: farmerPayments,
    firm_transactions: firmTransactions,
    summary: {
      expenses: { count: expenses.length, debit: expTotal.debit, credit: expTotal.credit },
      commissions: { count: commissions.length, total: commTotal },
      plot_payments: { count: plotPayments.length, total: plotPayTotal },
      farmer_payments: { count: farmerPayments.length, total: farmerPayTotal },
      firm_transactions: { count: firmTransactions.length, debit: firmTotal.debit, credit: firmTotal.credit },
      grand_total_entries: expenses.length + commissions.length + plotPayments.length + farmerPayments.length + firmTransactions.length,
    },
  });
});
