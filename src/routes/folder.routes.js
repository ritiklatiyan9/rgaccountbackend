import express from 'express';
import authMiddleware from '../middlewares/auth.middleware.js';
import {
    listFolders,
    createFolder,
    renameFolder,
    moveFolder,
    deleteFolder,
} from '../controllers/folder.controller.js';

const router = express.Router();

router.use(authMiddleware);

router.get('/', listFolders);
router.post('/', createFolder);
router.put('/:id/rename', renameFolder);
router.put('/:id/move', moveFolder);
router.delete('/:id', deleteFolder);

export default router;
