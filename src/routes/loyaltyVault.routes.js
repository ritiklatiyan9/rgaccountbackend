import { Router } from 'express';
import authMiddleware from '../middlewares/auth.middleware.js';
import pool from '../config/db.js';
import asyncHandler from '../utils/asyncHandler.js';
import { summary,holders,history,historyDetail,assignment,transfers,createTransfer,resolveTransfer,userDetail,assignedTransactions } from '../controllers/loyaltyVault.controller.js';
const router=Router();
router.use(authMiddleware);
router.use(asyncHandler(async(req,res,next)=>{
  const {rows}=await pool.query("SELECT to_jsonb(s)->>'consolidated_at' AS consolidated_at FROM loyalty_vault_settings s LIMIT 1");
  if(!rows[0]?.consolidated_at) return res.status(503).json({message:'Cash Wallet setup is pending. Run migrate:unified-cash-wallet.',code:'WALLET_NOT_READY'});
  next();
}));
router.get('/',summary);
router.get('/holders',holders);
router.get('/users/:id',userDetail);
router.get('/transactions',assignedTransactions);
router.get('/assignment',assignment);
router.get('/history',history);
router.get('/history/:id',historyDetail);
router.get('/transfers',transfers);
router.post('/transfers',createTransfer);
router.post('/transfers/:id/accept',resolveTransfer('accept'));
router.post('/transfers/:id/reject',resolveTransfer('reject'));
router.post('/transfers/:id/cancel',resolveTransfer('cancel'));
router.use((error,req,res,next)=>{
  if(['42P01','42883','42703'].includes(error.code)) return res.status(503).json({message:'Cash Wallet setup is pending. Run migrate:unified-cash-wallet.',code:'WALLET_NOT_READY'});
  next(error);
});
export default router;
