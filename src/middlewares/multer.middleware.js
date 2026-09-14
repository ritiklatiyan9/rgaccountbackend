import multer from 'multer';
import path from 'path';
import fs from 'fs';

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'src/uploads');
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + path.extname(file.originalname));
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
  const mimeAllowed = allowedMimeTypes.has(String(file.mimetype || '').toLowerCase());
  if (mimeAllowed && extensionAllowed) {
    return cb(null, true);
  } else {
    cb(new Error('Unsupported file type'));
  }
};

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter
});

export const cleanupFile = (filePath) => {
  fs.unlink(filePath, (err) => {
    if (err) console.error('Error deleting file:', err);
  });
};

export default upload;
