import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { randomUUID } from 'node:crypto';
import { evidenceMime } from '../utils/evidenceFile.js';

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    fs.mkdir('src/uploads', { recursive: true }, error => cb(error, 'src/uploads'));
  },
  filename: (req, file, cb) => {
    cb(null, `${Date.now()}-${randomUUID()}${path.extname(file.originalname).toLowerCase()}`);
  }
});

const fileFilter = (req, file, cb) => {
  const allowedExtensions = new Set([
    '.jpg', '.jpeg', '.png', '.webp', '.pdf', '.doc', '.docx', '.xls', '.xlsx',
    '.csv', '.txt', '.aac', '.m4a', '.mp3', '.ogg', '.wav', '.webm',
  ]);
  const allowedMimeTypes = new Set([
    'image/jpeg', 'image/png', 'image/webp', 'application/pdf', 'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'text/csv', 'text/plain', 'audio/aac', 'audio/mp4', 'audio/mpeg', 'audio/ogg',
    'audio/wav', 'audio/webm', 'video/webm',
  ]);
  const extensionAllowed = allowedExtensions.has(path.extname(file.originalname).toLowerCase());
  const canonicalEvidenceMime = evidenceMime(file);
  const isEvidenceExtension = /\.(jpg|jpeg|png|webp|pdf)$/i.test(file.originalname || '');
  const mimeAllowed = isEvidenceExtension ? !!canonicalEvidenceMime : allowedMimeTypes.has(String(file.mimetype || '').toLowerCase());
  if (mimeAllowed && extensionAllowed) {
    if (canonicalEvidenceMime) file.mimetype = canonicalEvidenceMime;
    return cb(null, true);
  } else {
    cb(Object.assign(new Error('Unsupported file type'), { statusCode: 400 }));
  }
};

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter
});

export const receiveUpload = handler => (req, res, next) => handler(req, res, error => {
  if (!error) {
    const files = req.files || (req.file ? [req.file] : []);
    if (files.some(file => !file.size)) {
      files.forEach(file => cleanupFile(file.path));
      return res.status(400).json({ message: 'The selected file is empty. Choose another file.' });
    }
    return next();
  }
  const tooLarge = error.code === 'LIMIT_FILE_SIZE';
  res.status(tooLarge ? 413 : 400).json({
    message: tooLarge ? 'File is too large. Choose a file up to 5 MB.' : error.message,
    code: error.code || 'INVALID_FILE_TYPE',
  });
});

export const cleanupFile = (filePath) => {
  fs.unlink(filePath, (err) => {
    if (err) console.error('Error deleting file:', err);
  });
};

export default upload;
