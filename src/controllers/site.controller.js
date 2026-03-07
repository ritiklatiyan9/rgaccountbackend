import asyncHandler from '../utils/asyncHandler.js';
import siteModel from '../models/Site.model.js';
import pool from '../config/db.js';

/**
 * POST /sites
 * Create a new site (admin only)
 */
export const createSite = asyncHandler(async (req, res) => {
  const { name, code, address, city, state, description, status } = req.body;

  if (!name) {
    return res.status(400).json({ message: 'Site name is required' });
  }

  // Check unique code
  if (code) {
    const existing = await siteModel.findByCode(code, pool);
    if (existing) return res.status(400).json({ message: 'Site code already exists' });
  }

  const siteData = {
    name,
    code: code || null,
    address: address || null,
    city: city || null,
    state: state || null,
    description: description || null,
    status: status || 'active',
    created_by: req.user.id,
  };

  const site = await siteModel.create(siteData, pool);
  res.status(201).json({ site });
});

/**
 * GET /sites
 * Get sites – admin gets all, sub_admin gets only assigned sites
 */
export const listSites = asyncHandler(async (req, res) => {
  let sites;

  if (req.user.role === 'admin') {
    sites = await siteModel.findAll(pool);
  } else {
    sites = await siteModel.findByUserId(req.user.id, pool);
  }

  res.json({ sites });
});

/**
 * GET /sites/:id
 * Get a single site
 */
export const getSite = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const site = await siteModel.findById(parseInt(id), pool);

  if (!site) {
    return res.status(404).json({ message: 'Site not found' });
  }

  // Sub-admins can only access assigned sites
  if (req.user.role === 'sub_admin') {
    const userSites = await siteModel.findByUserId(req.user.id, pool);
    const hasAccess = userSites.some(s => s.id === site.id);
    if (!hasAccess) return res.status(403).json({ message: 'Access denied to this site' });
  }

  res.json({ site });
});

/**
 * PUT /sites/:id
 * Update a site (admin only)
 */
export const updateSite = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { name, code, address, city, state, description, status } = req.body;

  const site = await siteModel.findById(parseInt(id), pool);
  if (!site) return res.status(404).json({ message: 'Site not found' });

  // Check unique code if changed
  if (code && code !== site.code) {
    const existing = await siteModel.findByCode(code, pool);
    if (existing) return res.status(400).json({ message: 'Site code already exists' });
  }

  const updateData = {};
  if (name) updateData.name = name;
  if (code !== undefined) updateData.code = code;
  if (address !== undefined) updateData.address = address;
  if (city !== undefined) updateData.city = city;
  if (state !== undefined) updateData.state = state;
  if (description !== undefined) updateData.description = description;
  if (status) updateData.status = status;

  const updated = await siteModel.update(parseInt(id), updateData, pool);
  res.json({ site: updated });
});

/**
 * DELETE /sites/:id
 * Delete a site (admin only)
 */
export const deleteSite = asyncHandler(async (req, res) => {
  const { id } = req.params;

  const site = await siteModel.findById(parseInt(id), pool);
  if (!site) return res.status(404).json({ message: 'Site not found' });

  await siteModel.delete(parseInt(id), pool);
  res.json({ message: 'Site deleted' });
});
