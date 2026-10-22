import { Router } from 'express';
import authMiddleware from '../middlewares/auth.middleware.js';
import pool from '../config/db.js';
import asyncHandler from '../utils/asyncHandler.js';
import { summary,overall,siteBalance,holders,history,historyDetail,assignment,transfers,createTransfer,resolveTransfer,userDetail,assignedTransactions } from '../controllers/loyaltyVault.controller.js';
const router=Router();
let ready = false;
let readiness = null;
function walletReady() {
  if (ready) return Promise.resolve(true);
  if (!readiness) readiness = pool.query(`SELECT to_jsonb(s)->>'consolidated_at' AS consolidated_at,
      EXISTS(SELECT 1 FROM app_schema_migrations WHERE version='210_wallet_balance_guards') AS balance_guards_ready,
      EXISTS(SELECT 1 FROM app_schema_migrations WHERE version='211_locked_cash_collector') AS collector_lock_ready
      FROM loyalty_vault_settings s LIMIT 1`)
    .then(({ rows }) => { ready = !!rows[0]?.consolidated_at && rows[0]?.balance_guards_ready === true && rows[0]?.collector_lock_ready === true; return ready; })
    .finally(() => { readiness = null; });
  return readiness;
}
router.use(authMiddleware);
router.use(asyncHandler(async(req,res,next)=>{
  if(!await walletReady()) return res.status(503).json({message:'Cash Wallet setup is pending. Apply the wallet migrations through migrate:locked-cash-collector and restart the backend.',code:'WALLET_NOT_READY'});
  next();
}));
router.get('/',summary);
router.get('/overall',overall);
router.get('/site-balance',siteBalance);
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
  if(['42P01','42883','42703'].includes(error.code)) return res.status(503).json({message:'Cash Wallet setup is pending. Apply the wallet migrations through migrate:locked-cash-collector and restart the backend.',code:'WALLET_NOT_READY'});
  next(error);
});
export default router;
