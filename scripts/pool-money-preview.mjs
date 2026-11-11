// Local Pool Money and project-profile API. No startup migrations, backfills,
// scheduled workers or unrelated financial routes run from this entry point.
import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import express from 'express';
import cors from 'cors';
import pool from '../src/config/db.js';
import { createSeekPermissionPreviewAuth } from '../src/middlewares/seekPermissionPreviewAuth.middleware.js';
import requireRole from '../src/middlewares/role.middleware.js';
import auditRequestMiddleware from '../src/middlewares/audit.middleware.js';
import errorMiddleware from '../src/middlewares/error.middleware.js';
import { updateSite } from '../src/controllers/site.controller.js';
import { getCommissionAllocations, getCommissionReceivers } from '../src/controllers/plotCommissionV2.controller.js';
import { createPlot, updatePlot, cancelBooking, rebookPlot } from '../src/controllers/plot.controller.js';
import requirePermission from '../src/middlewares/permission.middleware.js';
import requirePlotSiteAccess from '../src/middlewares/plotSiteAccess.middleware.js';
import { invalidateCacheOnSuccess } from '../src/middlewares/cache.middleware.js';
import { listPendingCheques, manuallyUpdateChequeStatus } from '../src/controllers/bankReconciliation.controller.js';
import { updateChequeStatus } from '../src/controllers/approval.controller.js';
import { listDayBookEntries, getModeBalance } from '../src/controllers/daybook.controller.js';
import { assertPoolSiteAccess } from '../src/services/poolMoney.service.js';
import { listBankAccounts, listBankEntries } from '../src/controllers/bank.controller.js';

export const POOL_PREVIEW_ORIGINS = Object.freeze(['http://127.0.0.1:5173', 'http://localhost:5173']);
export const isPoolPreviewOrigin = origin => !origin || POOL_PREVIEW_ORIGINS.includes(origin);
export function poolPreviewPort(value = process.env.POOL_MONEY_PREVIEW_PORT || 8009) {
  if (!/^\d+$/.test(String(value)) || Number(value) < 1 || Number(value) > 65535) {
    throw new Error('POOL_MONEY_PREVIEW_PORT must be between 1 and 65535.');
  }
  return Number(value);
}

export function createPoolMoneyPreviewApp({ authenticate, poolMoneyRouter, database = pool,
  saveProjectProfile = updateSite, createShop = createPlot, updateShop = updatePlot,
  audit = auditRequestMiddleware, commissionRouter } = {}) {
  if (typeof authenticate !== 'function' || !poolMoneyRouter) throw new Error('Preview authentication and Pool Money router are required.');
  const app = express();
  app.disable('x-powered-by');
  app.use(cors({
    origin(origin, callback) {
      callback(isPoolPreviewOrigin(origin) ? null : Object.assign(new Error('This preview only accepts the Accounts dashboard on localhost:5173.'), { statusCode: 403 }), true);
    },
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type', 'X-Session-ID', 'X-App-Context', 'X-Transaction-Date', 'X-Transaction-Time'],
  }));
  app.use(express.json({ limit: '128kb' }));
  app.get('/health', (_req, res) => res.set('Cache-Control', 'no-store').json({ service: 'pool-money-preview', version: 1, commission_allocations: Boolean(commissionRouter), booking_allocations: true, booking_history: true }));
  app.use(['/plots/pool-money', '/sites'], authenticate, (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  app.use(audit);
  app.use('/plots', poolMoneyRouter);
  if (commissionRouter) app.use('/plot-commission', authenticate, (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); }, commissionRouter);

  const shopBody = (req, res, next) => (['plot','flat','shop'].includes(req.body?.unit_type)
    || req.body?.unit_type === undefined)
    ? next() : res.status(400).json({ message: 'Choose a supported property unit type.' });
  const shopOrganization = async (req, res, next) => {
    try {
      const isUpdate = req.params.id !== undefined;
      const value = isUpdate ? req.params.id : req.body.site_id;
      if (!/^\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value)) || Number(value) < 1) {
        return res.status(400).json({ message: 'A valid site and property are required.' });
      }
      const { rows } = await database.query(isUpdate
        ? 'SELECT p.site_id,p.unit_type FROM plots p JOIN sites s ON s.id=p.site_id WHERE p.id=$1 AND s.organization_id=$2'
        : 'SELECT id AS site_id FROM sites WHERE id=$1 AND organization_id=$2', [Number(value), req.user.organization_id]);
      if (!rows.length) return res.status(404).json({ message: 'Site or property not found.' });
      if (req.body.site_id != null && Number(req.body.site_id) !== Number(rows[0].site_id)) {
        return res.status(400).json({ message: 'A property cannot be moved to a different site.' });
      }
      next();
    } catch (error) { next(error); }
  };
  const bustPlotCache = invalidateCacheOnSuccess(['approvals|', '/approvals', 'plots|', 'plots:pageData:', 'plot-commissions|',
    'plot-commissions-plots|', 'members|', '/daybook', 'registries|', 'registries-meta|']);
  app.get('/plots/booking-receivers', authenticate, requireRole('admin', 'sub_admin'), requirePermission('plot_payments', 'read'),
    (_req, res, next) => { res.set('Cache-Control','no-store'); next(); }, getCommissionReceivers);
  app.get('/plots/:id/booking-allocations', authenticate, requireRole('admin', 'sub_admin'), requirePermission('plot_payments', 'read'),
    requirePlotSiteAccess({ entity: 'plot', source: 'params', key: 'id' }),
    (req, res, next) => { res.set('Cache-Control','no-store'); req.query.plot_id=req.params.id; next(); }, getCommissionAllocations);
  app.get('/plots/:id/cancellation-preview',authenticate,requireRole('admin','sub_admin'),requirePermission('plot_payments','update'),
    requirePlotSiteAccess({entity:'plot',source:'params',key:'id'}),(req,res,next)=>{res.set('Cache-Control','no-store');req.query.plot_id=req.params.id;req.includeSettlementBalances=true;next();},getCommissionAllocations);
  app.post('/plots/:id/cancel-booking', authenticate, requireRole('admin','sub_admin'), requirePermission('plot_payments','update'),
    requirePlotSiteAccess({entity:'plot',source:'params',key:'id'}),bustPlotCache,cancelBooking);
  app.post('/plots/:id/rebook', authenticate, requireRole('admin','sub_admin'), requirePermission('plot_payments','write'),requirePermission('plot_payments','update'),
    requirePlotSiteAccess({entity:'plot',source:'params',key:'id'}),bustPlotCache,rebookPlot);
  app.post('/plots', authenticate, requireRole('admin', 'sub_admin'), requirePermission('plot_payments', 'write'), shopBody,
    shopOrganization, requirePlotSiteAccess({ entity: 'site', source: 'body', key: 'site_id' }), bustPlotCache, createShop);
  app.put('/plots/:id', authenticate, requireRole('admin', 'sub_admin'), requirePermission('plot_payments', 'update'), shopBody,
    shopOrganization, requirePlotSiteAccess({ entity: 'plot', source: 'params', key: 'id' }), bustPlotCache, updateShop);

  // Reuse the same independently verified/manual cheque workflow as the main
  // Pending Cheque Matching page. Its controller enforces organization/site,
  // a confirmation, a reason, and the actual bank transaction date.
  app.get('/bank-reconciliation/pending-cheques', authenticate, requireRole('admin', 'sub_admin'),
    requirePermission('expense_approval', 'read'), listPendingCheques);
  app.post('/bank-reconciliation/cheques/:source/:entryId/manual-status', authenticate, requireRole('admin', 'sub_admin'),
    requirePermission('expense_approval', 'read'), requirePermission('expense_approval', 'update'),
    (req, res, next) => req.params.source === 'pool_money_receipt' ? next()
      : res.status(400).json({ message: 'Use the main API for other cheque sources.' }), bustPlotCache, manuallyUpdateChequeStatus);
  app.patch('/approvals/cheque-status', authenticate, requireRole('admin', 'sub_admin'),
    requirePermission('expense_approval', 'read'), requirePermission('expense_approval', 'update'),
    async (req, res, next) => {
      if (req.body.source !== 'pool_money_receipt' || !/^\d+$/.test(String(req.body.id))) {
        return res.status(400).json({ message: 'A Pool Money cheque source is required.' });
      }
      try {
        const { rows } = await database.query(`SELECT r.id FROM pool_money_receipts r JOIN sites s ON s.id=r.site_id
          WHERE r.id=$1 AND s.organization_id=$2`, [Number(req.body.id), req.user.organization_id]);
        if (!rows.length) return res.status(404).json({ message: 'Pool receipt not found.' });
        next();
      } catch (error) { next(error); }
    }, bustPlotCache, updateChequeStatus);

  const readDaybookSite = async (req, _res, next) => {
    try { await assertPoolSiteAccess(database, req.user, req.query.site_id); next(); }
    catch (error) { next(error); }
  };
  app.get('/daybook', authenticate, requireRole('admin', 'sub_admin'), requirePermission('daybook', 'read'), readDaybookSite, listDayBookEntries);
  app.get('/daybook/mode-balance', authenticate, requireRole('admin', 'sub_admin'), requirePermission('daybook', 'read'), readDaybookSite, getModeBalance);
  app.get('/banks', authenticate, requireRole('admin', 'sub_admin'), requirePermission('daybook', 'read'), listBankAccounts);
  app.get('/banks/:id/entries', authenticate, requireRole('admin', 'sub_admin'), requirePermission('daybook', 'read'), listBankEntries);

  // Only profile reads and a profile-only save are exposed here. Other site
  // settings and financial operations continue to use the configured main API.
  app.get('/sites', async (req, res, next) => {
    try {
      const { rows: sites } = await database.query(`SELECT s.* FROM sites s WHERE s.organization_id=$1
        AND ($2::boolean OR EXISTS(SELECT 1 FROM user_sites us WHERE us.site_id=s.id AND us.user_id=$3))
        ORDER BY s.created_at DESC`, [req.user.organization_id, ['admin', 'super_admin'].includes(req.user.role), req.user.id]);
      res.json({ sites, project_profile_supported: sites.every(site => Boolean(site.project_profile)) });
    } catch (error) { next(error); }
  });
  const siteScope = async (req, res, next) => {
    if (!/^\d+$/.test(req.params.id) || !Number.isSafeInteger(Number(req.params.id)) || Number(req.params.id) < 1) {
      return res.status(400).json({ message: 'A valid site is required.' });
    }
    try {
      const { rows: [site] } = await database.query(`SELECT s.* FROM sites s WHERE s.id=$1 AND s.organization_id=$2
        AND ($3::boolean OR EXISTS(SELECT 1 FROM user_sites us WHERE us.site_id=s.id AND us.user_id=$4))`,
      [Number(req.params.id), req.user.organization_id, ['admin', 'super_admin'].includes(req.user.role), req.user.id]);
      if (!site) return res.status(404).json({ message: 'Site not found or unavailable.' });
      req.previewSite = site;
      next();
    } catch (error) { next(error); }
  };
  app.get('/sites/:id', siteScope, (req, res) => res.json({ site: req.previewSite, project_profile_supported: Boolean(req.previewSite.project_profile) }));
  app.put('/sites/:id', requireRole('admin'), siteScope, (req, res, next) => {
    const keys = Object.keys(req.body || {});
    if (keys.length !== 1 || keys[0] !== 'project_profile') {
      return res.status(400).json({ message: 'This preview accepts only project_profile changes.' });
    }
    return saveProjectProfile(req, res, next);
  });
  app.use((_req, res) => res.status(404).json({ message: 'This preview only serves Pool Money and project profiles.' }));
  app.use(errorMiddleware);
  return app;
}

export async function startPoolMoneyPreview({ port = poolPreviewPort(), database = pool } = {}) {
  const { createPoolMoneyRouter } = await import('../src/routes/poolMoney.routes.js');
  const { createPlotCommissionRouter } = await import('../src/routes/plotCommissionV2.routes.js');
  const { authenticate } = createSeekPermissionPreviewAuth({ database });
  // Authentication is applied to the narrow mounts by the app. The production
  // router retains its own role, module and site guards unchanged.
  const app = createPoolMoneyPreviewApp({ database, authenticate,
    poolMoneyRouter: createPoolMoneyRouter({ authenticate: (_req, _res, next) => next() }),
    commissionRouter: createPlotCommissionRouter({ authenticate: (_req, _res, next) => next() }) });
  const server = await new Promise((resolve, reject) => {
    const listener = app.listen(poolPreviewPort(port), '127.0.0.1', () => resolve(listener));
    listener.once('error', reject);
  });
  return { app, server, port: server.address().port };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startPoolMoneyPreview().then(({ server, port }) => {
    console.log(`Pool Money preview ready on http://127.0.0.1:${port}`);
    for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => {
      server.close(() => pool.end().finally(() => process.exit(0)));
      setTimeout(() => process.exit(0), 5000).unref();
    });
  }).catch(async error => {
    console.error('Pool Money preview failed:', error.message);
    await pool.end();
    process.exitCode = 1;
  });
}
