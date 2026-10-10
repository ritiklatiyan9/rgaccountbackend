import express from 'express';
const router = express.Router();

import { uploadSingle, uploadMany } from '../utils/upload.js';
import upload, { receiveUpload } from '../middlewares/multer.middleware.js';
import authMiddleware from '../middlewares/auth.middleware.js';
import { signExpenseDocumentUrl } from '../utils/expenseDocumentUrls.js';

router.post('/single', authMiddleware, receiveUpload(upload.single('file')), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: 'No file uploaded' });
    const { provider = 's3' } = req.query;
    const url = await uploadSingle(req.file, provider);
    res.json({ url, fileUrl: url });
  } catch (err) {
    console.error('[Upload] Failed:', err.message);
    res.status(500).json({ message: 'File upload failed: ' + err.message });
  }
});

router.post('/many', authMiddleware, receiveUpload(upload.array('files')), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) return res.status(400).json({ message: 'No files uploaded' });
    const { provider = 's3' } = req.query;
    const urls = await uploadMany(req.files, provider);
    // Opt-in for the expense draft: other upload callers keep durable URLs.
    const previewUrls = req.query.preview === 'true'
      ? await Promise.all(urls.map((url) => signExpenseDocumentUrl(url)))
      : urls;
    res.json({ urls: previewUrls });
  } catch (err) {
    console.error('[Upload] Failed:', err.message);
    res.status(500).json({ message: 'File upload failed: ' + err.message });
  }
});

export default router;
