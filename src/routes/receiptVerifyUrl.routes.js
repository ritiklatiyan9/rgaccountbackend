import express from 'express';
import { getReceiptVerifyUrl } from '../controllers/receiptVerifyUrl.controller.js';
import authMiddleware from '../middlewares/auth.middleware.js';

const router = express.Router();

// Signed-in users only — the token is minted from stored data, and site access
// is checked per record inside the controller.
router.get('/verify-url', authMiddleware, getReceiptVerifyUrl);

export default router;
