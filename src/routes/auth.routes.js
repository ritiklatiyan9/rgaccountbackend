import express from 'express';
const router = express.Router();

import { register, login, refresh, logout, updateProfile, getMe } from '../controllers/auth.controller.js';
import authMiddleware from '../middlewares/auth.middleware.js';
import upload from '../middlewares/multer.middleware.js';

router.post('/register', upload.single('photo'), register);  // First admin only (Postman)
router.post('/login', login);
router.post('/refresh', refresh);
router.post('/logout', authMiddleware, logout);
router.get('/me', authMiddleware, getMe);
router.put('/profile', authMiddleware, upload.single('photo'), updateProfile);

export default router;