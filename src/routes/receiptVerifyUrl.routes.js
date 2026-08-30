import express from 'express';
import {
  getReceiptVerifyUrl,
  verifyPublicReceipt,
} from '../controllers/receiptVerifyUrl.controller.js';
import authMiddleware from '../middlewares/auth.middleware.js';

const router = express.Router();

// Public destination used by defencegarden.com after a receipt QR is scanned.
// Keep this before any authenticated receipt routes.
router.get('/verify', verifyPublicReceipt);

// Signed-in users only — the token is minted from stored data, and site access
// is checked per record inside the controller.
router.get('/verify-url', authMiddleware, getReceiptVerifyUrl);

export default router;
