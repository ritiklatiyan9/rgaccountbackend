import express from 'express';
const router = express.Router();

import authRoutes from './auth.routes.js';
import uploadRoutes from './upload.routes.js';
import adminRoutes from './admin.routes.js';
import siteRoutes from './site.routes.js';
import farmerRoutes from './farmer.routes.js';
import commissionRoutes from './commission.routes.js';
import cashflowRoutes from './cashflow.routes.js';
import firmRoutes from './firm.routes.js';
import plotRoutes from './plot.routes.js';
import expenseRoutes from './expense.routes.js';
import registryRoutes from './registry.routes.js';
import memberRoutes from './member.routes.js';
import daybookRoutes from './daybook.routes.js';
import imprestRoutes from './imprest.routes.js';
import editRequestRoutes from './editRequest.routes.js';
import permissionRoutes from './permission.routes.js';

router.use('/auth', authRoutes);
router.use('/upload', uploadRoutes);
router.use('/admin', adminRoutes);
router.use('/sites', siteRoutes);
router.use('/farmers', farmerRoutes);
router.use('/commissions', commissionRoutes);
router.use('/cashflow', cashflowRoutes);
router.use('/firms', firmRoutes);
router.use('/plots', plotRoutes);
router.use('/expenses', expenseRoutes);
router.use('/registries', registryRoutes);
router.use('/members', memberRoutes);
router.use('/daybook', daybookRoutes);
router.use('/imprest', imprestRoutes);
router.use('/edit-requests', editRequestRoutes);
router.use('/permissions', permissionRoutes);

export default router;