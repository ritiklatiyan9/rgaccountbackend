import { Router } from 'express';
import { cacheResponse } from '../middlewares/cache.middleware.js';
import { authorizeWalletImprestRead,participants,list,create,resolve } from '../controllers/walletImprestTransfer.controller.js';

const router=Router();
// Authorization always precedes the cache, including current site assignment
// and visibility grants. Mutations always run directly against PostgreSQL.
const cached=cacheResponse({namespace:'wallet-imprest',ttlSeconds:10});
router.get('/participants',authorizeWalletImprestRead,cached,participants);
router.get('/',authorizeWalletImprestRead,cached,list);
router.post('/',create);
router.post('/:id/accept',resolve('accept'));
router.post('/:id/reject',resolve('reject'));
router.post('/:id/cancel',resolve('cancel'));
router.use((error,req,res,next)=>{
  if(['42P01','42703','42883'].includes(error.code)) return res.status(503).json({message:'Wallet imprest transfers require migration migrate:wallet-imprest-transfers.',code:'WALLET_IMPREST_NOT_READY'});
  next(error);
});
export default router;
