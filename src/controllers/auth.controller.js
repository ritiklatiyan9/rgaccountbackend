import asyncHandler from '../utils/asyncHandler.js';
import { signAccessToken, signRefreshToken, verifyToken, hashPassword, comparePassword, hashRefreshToken } from '../config/jwt.js';
import { uploadSingle } from '../utils/upload.js';
import userModel from '../models/User.model.js';
import siteModel from '../models/Site.model.js';
import permissionModel from '../models/Permission.model.js';
import pool from '../config/db.js';

/**
 * POST /auth/register
 * First-ever admin registration via Postman (no auth required).
 * If an admin already exists, this endpoint is LOCKED.
 */
export const register = asyncHandler(async (req, res) => {
  const { name, email, password, phone } = req.body;

  // Only allow if NO admin exists yet
  const hasAdmin = await userModel.adminExists(pool);
  if (hasAdmin) {
    return res.status(403).json({ message: 'Admin already exists. Use admin panel to create sub-admins.' });
  }

  const existing = await userModel.findByEmail(email, pool);
  if (existing) return res.status(400).json({ message: 'User with this email already exists' });

  const hashedPassword = await hashPassword(password);
  let photoUrl = null;
  if (req.file) {
    photoUrl = await uploadSingle(req.file, 'cloudinary');
  }

  const userData = {
    name,
    email,
    password: hashedPassword,
    phone: phone || null,
    photo: photoUrl,
    role: 'admin',
    is_active: true,
    token_version: 1,
  };

  const user = await userModel.create(userData, pool);
  const accessToken = signAccessToken({ id: user.id, email: user.email, role: user.role, version: 1 });
  const refreshToken = signRefreshToken({ id: user.id, version: 1 });
  const hashedRefresh = await hashRefreshToken(refreshToken);
  await userModel.update(user.id, { refresh_token: hashedRefresh }, pool);

  res.status(201).json({ user: userModel.sanitize(user), accessToken, refreshToken });
});

/**
 * POST /auth/login
 */
export const login = asyncHandler(async (req, res) => {
  const { email, password } = req.body;
  const user = await userModel.findByEmail(email, pool);

  if (!user || !(await comparePassword(password, user.password))) {
    return res.status(401).json({ message: 'Invalid credentials' });
  }

  if (!user.is_active) {
    return res.status(403).json({ message: 'Account is deactivated. Contact your admin.' });
  }

  const newVersion = user.token_version + 1;
  await userModel.update(user.id, { token_version: newVersion }, pool);

  const accessToken = signAccessToken({ id: user.id, email: user.email, role: user.role, version: newVersion });
  const refreshToken = signRefreshToken({ id: user.id, version: newVersion });
  const hashedRefresh = await hashRefreshToken(refreshToken);
  await userModel.update(user.id, { refresh_token: hashedRefresh }, pool);

  // Fetch accessible sites
  let sites;
  if (user.role === 'admin') {
    sites = await siteModel.findAll(pool);
  } else {
    sites = await siteModel.findByUserId(user.id, pool);
  }

  // Fetch permissions for sub_admin
  let permissions = null;
  if (user.role === 'sub_admin') {
    permissions = await permissionModel.getByUserId(user.id);
  }

  res.json({
    user: userModel.sanitize(user),
    accessToken,
    refreshToken,
    sites,
    permissions,
  });
});

/**
 * POST /auth/refresh
 */
export const refresh = asyncHandler(async (req, res) => {
  const { refreshToken } = req.body;
  const decoded = verifyToken(refreshToken, process.env.JWT_REFRESH_SECRET);
  const user = await userModel.findById(decoded.id, pool);

  if (!user || user.token_version !== decoded.version) {
    if (user) await userModel.update(user.id, { token_version: user.token_version + 1, refresh_token: null }, pool);
    return res.status(401).json({ message: 'Invalid refresh token' });
  }

  if (!(await comparePassword(refreshToken, user.refresh_token))) {
    await userModel.update(user.id, { token_version: user.token_version + 1, refresh_token: null }, pool);
    return res.status(401).json({ message: 'Invalid refresh token' });
  }

  const newVersion = user.token_version + 1;
  await userModel.update(user.id, { token_version: newVersion }, pool);

  const accessToken = signAccessToken({ id: user.id, email: user.email, role: user.role, version: newVersion });
  const newRefreshToken = signRefreshToken({ id: user.id, version: newVersion });
  const hashedRefresh = await hashRefreshToken(newRefreshToken);
  await userModel.update(user.id, { refresh_token: hashedRefresh }, pool);

  res.json({ accessToken, refreshToken: newRefreshToken });
});

/**
 * POST /auth/logout
 */
export const logout = asyncHandler(async (req, res) => {
  const userId = req.user.id;
  await userModel.update(userId, { refresh_token: null }, pool);
  res.json({ message: 'Logged out' });
});

/**
 * GET /auth/me
 * Get current user profile + accessible sites
 */
export const getMe = asyncHandler(async (req, res) => {
  const user = await userModel.findById(req.user.id, pool);
  if (!user) return res.status(404).json({ message: 'User not found' });

  let sites;
  if (user.role === 'admin') {
    sites = await siteModel.findAll(pool);
  } else {
    sites = await siteModel.findByUserId(user.id, pool);
  }

  // Fetch permissions for sub_admin
  let permissions = null;
  if (user.role === 'sub_admin') {
    permissions = await permissionModel.getByUserId(user.id);
  }

  res.json({ user: userModel.sanitize(user), sites, permissions });
});

/**
 * PUT /auth/profile
 */
export const updateProfile = asyncHandler(async (req, res) => {
  const { name, email, password, phone } = req.body;
  const userId = req.user.id;
  let updateData = {};

  if (name) updateData.name = name;
  if (email) updateData.email = email;
  if (phone !== undefined) updateData.phone = phone;
  if (password) updateData.password = await hashPassword(password);
  if (req.file) {
    const photoUrl = await uploadSingle(req.file, 'cloudinary');
    updateData.photo = photoUrl;
  }

  const updatedUser = await userModel.update(userId, updateData, pool);
  res.json({ user: userModel.sanitize(updatedUser) });
});