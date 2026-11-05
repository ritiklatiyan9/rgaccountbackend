import express from 'express';
import { createPoolMoneyReceiptRouter } from './poolMoneyReceipt.routes.js';
import pool from '../config/db.js';
import authMiddleware from '../middlewares/auth.middleware.js';
import requireRole from '../middlewares/role.middleware.js';
import requirePermission from '../middlewares/permission.middleware.js';
import { invalidateCacheOnSuccess } from '../middlewares/cache.middleware.js';
import { resolveEntryVisibility } from '../services/entryVisibility.service.js';
import asyncHandler from '../utils/asyncHandler.js';
import { listPoolMoney,poolDetail,mutatePoolMoney,validatePoolIdentity,assertPoolSiteAccess } from '../services/poolMoney.service.js';

export function createPoolMoneyRouter({authenticate=authMiddleware,database=pool}={}) {
 const router=express.Router();
 router.use('/pool-money',authenticate,requireRole('admin','sub_admin'),requirePermission('plot_payments','read'));
 router.use(createPoolMoneyReceiptRouter({authenticate:(_req,_res,next)=>next(),database}));
 const siteGuard=source=>asyncHandler(async(req,res,next)=>{await assertPoolSiteAccess(database,req.user,req[source]?.site_id);next();});
 const readSite=siteGuard('query');
 const bodySite=siteGuard('body');
 const invalidate=invalidateCacheOnSuccess(['plots|','plots:pageData:','approvals|','/approvals','/daybook','daybook|','cashflow|','wallet|','loyalty-vault|','banks|']);
 router.get('/pool-money',readSite,asyncHandler(async(req,res)=>res.json(await listPoolMoney(database,req.query.site_id,await resolveEntryVisibility(req.user,'plot_payments',req.query.created_by)))));
 router.get('/pool-money/:kind/:id',readSite,asyncHandler(async(req,res)=>res.json(await poolDetail(database,validatePoolIdentity(req.params.kind,req.params.id,req.query.site_id),await resolveEntryVisibility(req.user,'plot_payments',req.query.created_by)))));
 for(const [method,action,permission] of [['put','result','update'],['post','record','write'],['post','allot','write']]) {
  router[method](`/pool-money/:kind/:id/${action}`,requireRole('admin'),requirePermission('plot_payments',permission),bodySite,invalidate,
   asyncHandler(async(req,res)=>res.json(await mutatePoolMoney(database,req.user,validatePoolIdentity(req.params.kind,req.params.id,req.body.site_id),action,req.body))));
 }
 return router;
}
export default createPoolMoneyRouter;
