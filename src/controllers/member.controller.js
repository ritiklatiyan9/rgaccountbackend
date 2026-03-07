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
  // Nominee
  'nominee_name', 'nominee_relation', 'nominee_phone',
  // Employee-specific
  'employee_id', 'designation', 'department', 'date_of_joining', 'salary', 'employment_type',
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
           'employment_type'].includes(f) && val) {
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

/** Upload all document files from req.files and return a map of field→url */
const uploadDocuments = async (files) => {
  const urls = {};
  if (!files) return urls;
  for (const fieldName of DOC_FIELDS) {
    const fileArr = files[fieldName];
    if (fileArr && fileArr.length > 0) {
      try {
        urls[fieldName] = await uploadSingle(fileArr[0], 'cloudinary');
      } catch (err) {
        console.error(`Upload failed for ${fieldName}:`, err);
      }
    }
  }
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

  // Handle document uploads (photo + KYC + employee docs)
  const docUrls = await uploadDocuments(req.files);
  Object.assign(data, docUrls);

  const member = await memberModel.create(data, pool);
  res.status(201).json({ member });
});

/** GET /members?site_id=X&type=CLIENT */
export const listMembers = asyncHandler(async (req, res) => {
  const { site_id, type } = req.query;
  if (!site_id) return res.status(400).json({ message: 'site_id is required' });

  const [members, summary] = await Promise.all([
    memberModel.findBySiteId(parseInt(site_id), pool, type || null),
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
  const { id } = req.params;
  const existing = await memberModel.findById(parseInt(id), pool);
  if (!existing) return res.status(404).json({ message: 'Member not found' });

  const data = sanitize(req.body);

  // Handle document uploads (photo + KYC + employee docs)
  const docUrls = await uploadDocuments(req.files);
  Object.assign(data, docUrls);

  // Handle removing documents
  for (const field of DOC_FIELDS) {
    if (req.body[`remove_${field}`] === 'true') {
      data[field] = null;
    }
  }

  if (Object.keys(data).length === 0) return res.status(400).json({ message: 'Nothing to update' });

  const updated = await memberModel.update(parseInt(id), data, pool);
  res.json({ member: updated });
});

/** DELETE /members/:id */
export const deleteMember = asyncHandler(async (req, res) => {
  const existing = await memberModel.findById(parseInt(req.params.id), pool);
  if (!existing) return res.status(404).json({ message: 'Member not found' });
  await memberModel.delete(parseInt(req.params.id), pool);
  res.json({ message: 'Member deleted' });
});
