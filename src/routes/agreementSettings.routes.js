import express from 'express';
import pool from '../config/db.js';
import authMiddleware from '../middlewares/auth.middleware.js';
import requirePermission from '../middlewares/permission.middleware.js';
import requireRole from '../middlewares/role.middleware.js';
import asyncHandler from '../utils/asyncHandler.js';

const SETTING_KEY = 'shop_agreement_defaults';
const DATE_FIELDS = new Set(['draw_date', 'resolution_date', 'deed_date', 'approval_date']);
const FIELD_KEYS = new Set([
  'place', 'village', 'tehsil', 'project_location', 'approval_area_sqm', 'company_legal_name', 'company_cin', 'company_pan', 'company_address',
  'notice_address', 'company_phone', 'company_email', 'signatory_name', 'signatory_designation',
  'land_numbers', 'land_sqm', 'land_sqft', 'land_north', 'land_south', 'land_east', 'land_west',
  'deed_no', 'registrar', 'deed_book', 'deed_volume', 'approval_number', 'architect', 'architect_registration',
  'disclosures', 'company_account_name', 'company_bank_branch', 'company_account_no', 'company_ifsc',
  'structure', 'walls', 'flooring', 'shutter', 'electrical', 'water', 'fire_safety', 'other_specifications',
  ...DATE_FIELDS,
]);

export function validateAgreementChanges(fields) {
  const invalid = message => { throw Object.assign(new Error(message), { statusCode: 400 }); };
  if (!fields || typeof fields !== 'object' || Array.isArray(fields) || !Object.keys(fields).length) {
    invalid('Provide the agreement fields to update.');
  }
  const changes = {};
  for (const [key, value] of Object.entries(fields)) {
    if (!FIELD_KEYS.has(key)) invalid('Unknown agreement field.');
    if (typeof value !== 'string' || value.length > 1500) invalid(`Enter up to 1,500 characters for ${key.replaceAll('_', ' ')}.`);
    const cleaned = value.trim();
    if (key === 'approval_area_sqm' && cleaned && (!/^\d+(\.\d+)?$/.test(cleaned) || !Number.isFinite(Number(cleaned)) || Number(cleaned) <= 0)) {
      invalid('Enter the area for approval in square metres as a positive number.');
    }
    if (cleaned && DATE_FIELDS.has(key) && (!/^\d{4}-\d{2}-\d{2}$/.test(cleaned) || !Number.isFinite(Date.parse(cleaned)) || new Date(cleaned).toISOString().slice(0, 10) !== cleaned)) {
      invalid(`Enter a valid date for ${key.replaceAll('_', ' ')}.`);
    }
    // A cleared override resumes use of the live letterhead or project profile.
    changes[key] = cleaned || null;
  }
  return changes;
}

export function agreementDefaults(profile = {}, letterhead = {}, overrides = {}) {
  const doc = letterhead.document_config || {};
  const source = {
    company_legal_name: letterhead.company_legal_name || profile.promoter_name,
    company_address: [letterhead.company_address, letterhead.company_city].filter(Boolean).join(', '),
    company_phone: letterhead.company_phone,
    company_email: letterhead.company_email,
    signatory_name: doc.signatory_name,
    signatory_designation: doc.signatory_designation,
    approval_number: profile.approval_number || doc.approval_number,
    approval_date: profile.approval_date || doc.approval_date,
    company_account_name: letterhead.payable_to,
    company_bank_branch: [letterhead.bank_name, letterhead.bank_branch].filter(Boolean).join(', '),
    company_account_no: letterhead.bank_account_no,
    company_ifsc: letterhead.bank_ifsc,
  };
  return Object.fromEntries(Array.from(FIELD_KEYS).flatMap(key => {
    const value = overrides[key] || source[key];
    return typeof value === 'string' && value.trim() ? [[key, value.trim()]] : [];
  }));
}

export function createAgreementSettingsRouter({ authenticate = authMiddleware, database = pool } = {}) {
  const router = express.Router();
  router.use(authenticate, requireRole('admin', 'sub_admin'), requirePermission('plot_payments', 'read'), (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  const loadSite = asyncHandler(async (req, res, next) => {
    const siteId = Number(req.query.site_id);
    if (!/^\d+$/.test(String(req.query.site_id)) || !Number.isSafeInteger(siteId) || siteId < 1) {
      return res.status(400).json({ message: 'Select a valid site.' });
    }
    const { rows } = await database.query(
      `SELECT s.id, to_jsonb(s)->'project_profile' AS profile,
              to_regclass('project_settings') IS NOT NULL AS has_letterhead FROM sites s
       WHERE s.id = $1 AND s.organization_id = $2 AND
         ($3::boolean OR EXISTS (SELECT 1 FROM user_sites WHERE site_id = s.id AND user_id = $4))`,
      [siteId, req.user.organization_id, ['admin', 'super_admin'].includes(req.user.role), req.user.id],
    );
    if (!rows.length) return res.status(404).json({ message: 'Site not found.' });
    req.agreementSite = rows[0];
    next();
  });

  async function loadLetterhead(site) {
    if (!site.has_letterhead) return {};
    const { rows } = await database.query(
      `SELECT company_legal_name, company_address, company_city, company_phone, company_email,
              payable_to, bank_name, bank_branch, bank_account_no, bank_ifsc,
              to_jsonb(p)->'document_config' AS document_config
       FROM project_settings p WHERE site_id = $1 LIMIT 1`, [site.id],
    );
    return rows[0] || {};
  }
  const respond = (req, res, letterhead, overrides) => res.json({
    site_id: req.agreementSite.id,
    fields: agreementDefaults(req.agreementSite.profile || {}, letterhead, overrides || {}),
  });
  router.get('/', loadSite, asyncHandler(async (req, res) => {
    const siteId = req.agreementSite.id;
    const [letterhead, { rows }] = await Promise.all([
      loadLetterhead(req.agreementSite),
      database.query('SELECT setting_value FROM application_settings WHERE site_id = $1 AND setting_key = $2', [siteId, SETTING_KEY]),
    ]);
    respond(req, res, letterhead, rows[0]?.setting_value);
  }));
  router.put('/', requireRole('admin'), loadSite, asyncHandler(async (req, res) => {
    const changes = validateAgreementChanges(req.body?.fields);
    const siteId = req.agreementSite.id;
    const letterhead = await loadLetterhead(req.agreementSite);
    const { rows } = await database.query(
      `INSERT INTO application_settings (site_id, setting_key, setting_value, updated_by, updated_at)
       VALUES ($1, $2, jsonb_strip_nulls($3::jsonb), $4, NOW())
       ON CONFLICT (site_id, setting_key) DO UPDATE SET
         setting_value = jsonb_strip_nulls(application_settings.setting_value || $3::jsonb),
         updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at
       RETURNING setting_value`, [siteId, SETTING_KEY, JSON.stringify(changes), req.user.id],
    );
    respond(req, res, letterhead, rows[0].setting_value);
  }));
  return router;
}
