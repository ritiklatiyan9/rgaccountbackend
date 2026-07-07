import express from 'express';
const router = express.Router();

import {
  register, login, googleLogin, verifyLoginOtp, resendLoginOtp,
  refresh, logout, updateProfile, getMe, changePassword,
} from '../controllers/auth.controller.js';
import authMiddleware from '../middlewares/auth.middleware.js';
import upload from '../middlewares/multer.middleware.js';

router.post('/register', upload.single('photo'), register);  // First admin only (Postman)
router.post('/login', login);
router.post('/google', googleLogin);          // Sign in with Google (Firebase ID token)
router.post('/verify-otp', verifyLoginOtp);   // Admin OTP second step
router.post('/resend-otp', resendLoginOtp);
router.post('/refresh', refresh);
router.post('/logout', authMiddleware, logout);
router.get('/me', authMiddleware, getMe);
router.put('/profile', authMiddleware, upload.single('photo'), updateProfile);
router.put('/change-password', authMiddleware, changePassword);

export default router;