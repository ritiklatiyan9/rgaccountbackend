import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';

const ACCESS_SECRET = process.env.JWT_ACCESS_SECRET;
const REFRESH_SECRET = process.env.JWT_REFRESH_SECRET;

export const signAccessToken = (payload) => jwt.sign(payload, ACCESS_SECRET, { expiresIn: '1d' });
export const signRefreshToken = (payload) => jwt.sign(payload, REFRESH_SECRET, { expiresIn: '7d' });
export const verifyToken = (token, secret = ACCESS_SECRET) => jwt.verify(token, secret);
export const hashPassword = async (password) => await bcrypt.hash(password, 10);
export const comparePassword = async (password, hash) => await bcrypt.compare(password, hash);
export const hashRefreshToken = async (token) => await bcrypt.hash(token, 10);