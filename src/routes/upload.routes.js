import express from 'express';
const router = express.Router();

import { uploadSingle, uploadMany } from '../utils/upload.js';
import upload from '../middlewares/multer.middleware.js';

router.post('/single', upload.single('file'), async (req, res) => {
  const { provider = 'cloudinary' } = req.query;
  const url = await uploadSingle(req.file, provider);
  res.json({ url });
});

router.post('/many', upload.array('files'), async (req, res) => {
  const { provider = 'cloudinary' } = req.query;
  const urls = await uploadMany(req.files, provider);
  res.json({ urls });
});

export default router;