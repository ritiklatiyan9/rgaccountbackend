import multer from 'multer';
import { evidenceMime } from '../utils/evidenceFile.js';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, done) => {
    const mime = evidenceMime(file);
    if (!mime) return done(new Error('Choose a PDF, JPG, PNG or WebP file.'));
    file.mimetype = mime;
    done(null, true);
  },
}).single('photo');

// Parse multipart fields before site/participant authorization reads req.body.
export default function receiveProof(req, res, next) {
  upload(req, res, error => {
    if (!error) {
      if (req.file && !req.file.size) return res.status(400).json({ message: 'The selected file is empty. Choose another file.' });
      return next();
    }
    const tooLarge = error.code === 'LIMIT_FILE_SIZE';
    res.status(tooLarge ? 413 : 400).json({
      message: tooLarge ? 'File is too large. Choose a file up to 10 MB.' : error.message,
      code: error.code || 'INVALID_FILE_TYPE',
    });
  });
}
