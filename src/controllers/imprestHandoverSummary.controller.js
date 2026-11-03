import pool from '../config/db.js';
import asyncHandler from '../utils/asyncHandler.js';
import { walletReadTransaction } from '../services/walletRead.service.js';
import { getImprestHandoverSummary } from '../services/imprestHandoverSummary.service.js';

export const imprestHandoverSummary=asyncHandler(async(req,res)=>{
  const data=await walletReadTransaction(pool,db=>getImprestHandoverSummary(db,{
    actor:{...req.user,...req.authenticatedUser},query:req.query,canReadPersonal:req.canReadPersonalImprest,canManage:req.canManageImprest,
  }),{repeatableRead:true});
  res.set('Cache-Control','no-store').json(data);
});
