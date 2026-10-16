import asyncHandler from '../utils/asyncHandler.js';
import { listModuleVisibility, setModuleVisibility } from '../services/moduleVisibility.service.js';
import { walletUser } from '../services/wallet.service.js';

const actorFor = async req => req.authenticatedUser || await walletUser(req.user);

export const getExpenseManagement = asyncHandler(async (req, res) => {
  const actor = await actorFor(req);
  const users = (await listModuleVisibility(actor, 'expenses')).map(({ view_all, ...user }) => ({ ...user, view_all_expenses: view_all }));
  res.set('Cache-Control', 'no-store').json({ users });
});

export const updateExpenseManagement = asyncHandler(async (req, res) => {
  const actor = await actorFor(req);
  const { user_id, view_all } = await setModuleVisibility(actor, 'expenses', req.params.userId, req.body?.enabled);
  res.set('Cache-Control', 'no-store').json({ user_id, view_all_expenses: view_all,
    message: view_all ? 'All-user expense visibility enabled' : 'Expense visibility limited to own entries' });
});
