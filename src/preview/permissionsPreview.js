import express from 'express';
import cors from 'cors';
import { getPermissions, updatePermissions } from '../controllers/permission.controller.js';
import { getMe } from '../controllers/auth.controller.js';
import { listPersonalLedgerPortfolio } from '../controllers/cashflow.controller.js';
import { listAllSitesCommissions } from '../controllers/plotCommissionV2.controller.js';
import requireRole from '../middlewares/role.middleware.js';
import requirePermission from '../middlewares/permission.middleware.js';
import { requireOverallSiteScope } from '../middlewares/overallSiteScope.middleware.js';
import auditRequestMiddleware from '../middlewares/audit.middleware.js';
import errorMiddleware from '../middlewares/error.middleware.js';

// A narrow local bridge for the current permissions catalogue. Financial writes
// continue using the configured API. No migrations or background workers run.
export function createPermissionsPreviewApp({ authenticate }) {
  if (typeof authenticate !== 'function') throw new Error('Permissions preview requires session authentication');
  const app = express();
  app.use(cors({ origin: ['http://127.0.0.1:5173', 'http://localhost:5173'], credentials: true }));
  app.use(express.json({ limit: '256kb' }));
  app.get('/health', (_req, res) => res.json({ service: 'permissions-preview', version: 1 }));
  app.use(authenticate);
  app.use(auditRequestMiddleware);
  app.get('/auth/me', getMe);
  app.get('/permissions/:userId', requireRole('admin'), getPermissions);
  app.put('/permissions/:userId', requireRole('admin'), updatePermissions);
  app.get('/cashflow/portfolio', requireRole('admin', 'sub_admin'), requirePermission('cashflow', 'read'), requirePermission('all_sites_personal_ledger', 'read'), requireOverallSiteScope, listPersonalLedgerPortfolio);
  app.get('/plot-commission/portfolio', requireRole('admin', 'sub_admin'), requirePermission('commissions', 'read'), requirePermission('all_sites_commission', 'read'), requireOverallSiteScope, listAllSitesCommissions);
  app.use(errorMiddleware);
  return app;
}
