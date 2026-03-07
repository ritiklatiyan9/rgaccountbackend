import express from 'express';
const router = express.Router();

import { createSite, listSites, getSite, updateSite, deleteSite } from '../controllers/site.controller.js';
import authMiddleware from '../middlewares/auth.middleware.js';
import requireRole from '../middlewares/role.middleware.js';

// All site routes require auth
router.use(authMiddleware);

router.get('/', listSites);                              // admin + sub_admin
router.get('/:id', getSite);                             // admin + sub_admin (access-checked)
router.post('/', requireRole('admin'), createSite);      // admin only
router.put('/:id', requireRole('admin'), updateSite);    // admin only
router.delete('/:id', requireRole('admin'), deleteSite); // admin only

export default router;
