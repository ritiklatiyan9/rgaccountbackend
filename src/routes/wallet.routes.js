import { Router } from 'express';
import authMiddleware from '../middlewares/auth.middleware.js';
import { summary, people, history, transfers, createTransfer, resolveTransfer } from '../controllers/wallet.controller.js';

const router = Router();
router.use(authMiddleware);
router.get('/', summary);
router.get('/people', people);
router.get('/history', history);
router.get('/transfers', transfers);
router.post('/transfers', createTransfer);
router.post('/transfers/:id/accept', resolveTransfer('accept'));
router.post('/transfers/:id/reject', resolveTransfer('reject'));
router.post('/transfers/:id/cancel', resolveTransfer('cancel'));
// Fail closed on installations that have not applied the wallet migration yet.
router.use((error, req, res, next) => {
  if (error.code === '42P01' || error.code === '42883') return res.status(503).json({ message: 'Wallet setup is pending. Run the cash wallet database migration.', code: 'WALLET_NOT_READY' });
  next(error);
});
export default router;
