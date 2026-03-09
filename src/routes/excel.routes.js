import express from 'express';
import multer from 'multer';
import authMiddleware from '../middlewares/auth.middleware.js';
import {
    createFile,
    listFiles,
    getRecentFiles,
    getFile,
    updateFile,
    renameFile,
    duplicateFile,
    deleteFile,
} from '../controllers/excel.controller.js';

const router = express.Router();
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
    fileFilter: (req, file, cb) => {
        const allowedTypes = [
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // xlsx
            'application/vnd.ms-excel', // xls
            'text/csv',
            'application/pdf',
            'application/msword', // doc
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // docx
        ];
        if (allowedTypes.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error('File type not supported. Allowed: xlsx, xls, csv, pdf, doc, docx'), false);
        }
    },
});

// All routes require authentication
router.use(authMiddleware);

router.post('/', upload.single('file'), createFile);
router.get('/', listFiles);
router.get('/recent', getRecentFiles);
router.get('/:id', getFile);
router.put('/:id', upload.single('file'), updateFile);
router.put('/:id/rename', renameFile);
router.post('/:id/duplicate', duplicateFile);
router.delete('/:id', deleteFile);

export default router;
