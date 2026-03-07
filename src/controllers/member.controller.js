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
           'occupation', 'company_name', 'reference', 'status'].includes(f) && val) {
        val = val.toUpperCase();
      }
      data[f] = val || null;
    }
  });
  return data;
};

/** POST /members — Create a new member */
export const createMember = asyncHandler(async (req, res) => {
  const { site_id } = req.body;
  if (!site_id) return res.status(400).json({ message: 'Site is required' });

  const data = sanitize(req.body);
  if (!data.full_name) return res.status(400).json({ message: 'Full name is required' });

  data.site_id = parseInt(site_id);
  data.created_by = req.user.id;

  // Handle photo upload via multer + cloudinary
  if (req.file) {
    try {
      data.photo = await uploadSingle(req.file, 'cloudinary');
    } catch (err) {
      console.error('Photo upload failed:', err);
    }
  }

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

  // Handle photo upload
  if (req.file) {
    try {
      data.photo = await uploadSingle(req.file, 'cloudinary');
    } catch (err) {
      console.error('Photo upload failed:', err);
    }
  }
  // Allow clearing photo
  if (req.body.remove_photo === 'true') {
    data.photo = null;
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
