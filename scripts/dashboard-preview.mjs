// A narrow local API for dashboard reads and administrator-managed visibility.
// Reuses the current Accounts session; no startup migrations or workers.
import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import express from 'express';
import cors from 'cors';
import { createHandler } from 'graphql-http/lib/use/express';
import { GraphQLSchema, GraphQLObjectType } from 'graphql';
import pool from '../src/config/db.js';
import { schema as accountsSchema } from '../src/graphql/schema.js';
import { createDashboardPermissionRouter } from '../src/routes/dashboardPermission.routes.js';
import siteCashReceiptRoutes from '../src/routes/siteCashReceipt.routes.js';
import { sources } from '../src/controllers/cashflowTransfer.controller.js';
import { createSeekPermissionPreviewAuth } from '../src/middlewares/seekPermissionPreviewAuth.middleware.js';
import requireRole from '../src/middlewares/role.middleware.js';
import requirePermission from '../src/middlewares/permission.middleware.js';
import { requireDashboardComponent } from '../src/middlewares/dashboardComponent.middleware.js';
import { listRecentTransactions } from '../src/controllers/daybook.controller.js';
import { getSiteBalance } from '../src/controllers/imprest.controller.js';
import { requireImprestReadAccess } from '../src/middlewares/imprestPermission.middleware.js';
import requireImprestSiteAccess from '../src/middlewares/imprestSiteAccess.middleware.js';
import auditRequestMiddleware from '../src/middlewares/audit.middleware.js';
import errorMiddleware from '../src/middlewares/error.middleware.js';

export function createDashboardPreviewApp({ authenticate, database = pool, audit = auditRequestMiddleware } = {}) {
  if (typeof authenticate !== 'function') throw new Error('Dashboard session authentication is required');
  const app = express();
  app.disable('x-powered-by');
  app.use(cors({
    origin(origin, callback) { callback(!origin || ['http://localhost:5173', 'http://127.0.0.1:5173'].includes(origin)
      ? null : Object.assign(new Error('Only the local Accounts dashboard can use this service'), { statusCode: 403 }), true); },
    methods: ['GET', 'POST', 'PUT', 'OPTIONS'], allowedHeaders: ['Authorization', 'Content-Type', 'X-Session-ID', 'X-App-Context'],
  }));
  app.use(express.json({ limit: '32kb' }));
  app.get('/health', (_req, res) => res.json({ service: 'dashboard-preview', version: 3 }));
  app.use(authenticate, (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); }, audit);
  app.use('/cashflow/site-receipts', siteCashReceiptRoutes);
  app.get('/cashflow/transfer-sources', requireRole('admin', 'sub_admin'), sources);
  // The hosted API cache is process-local. Use a live balance read after
  // transfers committed by this preview so both site balances refresh together.
  app.get('/imprest/site-balance', requireImprestReadAccess,
    requireImprestSiteAccess({ entity: 'site', source: 'query', key: 'site_id', required: true }), getSiteBalance);
  app.use('/dashboard-permissions', createDashboardPermissionRouter({ authenticate: (_req, _res, next) => next() }));
  app.get('/daybook/recent', requireRole('admin', 'sub_admin'), requirePermission('daybook', 'read'), requireDashboardComponent('recent_transactions'), listRecentTransactions);
  const fields = accountsSchema.getQueryType().toConfig().fields;
  const schema = new GraphQLSchema({ query: new GraphQLObjectType({ name: 'Query', fields: Object.fromEntries(
    ['kpiCards', 'revenueVsExpense', 'profitTrend', 'expensesByCategory', 'verifyFinancialIntegrity'].map(key => [key, fields[key]]),
  ) }) });
  app.all('/graphql', createHandler({ schema, context: async request => {
    const user = request.raw.user;
    if (user.role !== 'sub_admin') return { user, permissions: new Map(), siteIds: new Set() };
    const [permissions, sites] = await Promise.all([
      database.query('SELECT module, can_read FROM user_permissions WHERE user_id=$1', [user.id]),
      database.query('SELECT site_id FROM user_sites WHERE user_id=$1', [user.id]),
    ]);
    return { user, permissions: new Map(permissions.rows.map(row => [row.module, row])), siteIds: new Set(sites.rows.map(row => Number(row.site_id))) };
  } }));
  app.use((_req, res) => res.status(404).json({ message: 'This service only handles dashboard access and analytics' }));
  app.use(errorMiddleware);
  return app;
}

export async function startDashboardPreview({ port = Number(process.env.DASHBOARD_PREVIEW_PORT || 8010), database = pool } = {}) {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('Invalid dashboard preview port');
  const { authenticate } = createSeekPermissionPreviewAuth({ database });
  const app = createDashboardPreviewApp({ authenticate, database });
  const server = await new Promise((resolve, reject) => {
    const listener = app.listen(port, '127.0.0.1', () => resolve(listener)); listener.once('error', reject);
  });
  return { app, server, port: server.address().port };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startDashboardPreview().then(({ server, port }) => {
    console.log(`Dashboard preview ready on http://127.0.0.1:${port}`);
    for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => {
      server.close(() => pool.end().finally(() => process.exit(0)));
      setTimeout(() => process.exit(0), 5000).unref();
    });
  }).catch(async error => { console.error('Dashboard preview failed:', error.message); await pool.end(); process.exitCode = 1; });
}
