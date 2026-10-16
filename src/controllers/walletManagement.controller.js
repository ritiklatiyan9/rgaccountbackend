import asyncHandler from '../utils/asyncHandler.js';
import { vaultUser } from '../services/loyaltyVault.service.js';
import { walletError } from '../services/wallet.service.js';
import { isWalletAdmin, listWalletVisibility, setWalletVisibility } from '../services/walletVisibility.service.js';

async function managementActor(req) {
  const actor = await vaultUser(req.user);
  if (!isWalletAdmin(actor)) throw walletError('Only admins can manage wallet visibility.', 403);
  return actor;
}

export const getWalletManagement = asyncHandler(async (req, res) => {
  const actor = await managementActor(req);
  res.set('Cache-Control', 'no-store').json({ users: await listWalletVisibility(actor) });
});

export const updateWalletManagement = asyncHandler(async (req, res) => {
  const actor = await managementActor(req);
  const result = await setWalletVisibility(actor, req.params.userId, req.body?.enabled);
  res.set('Cache-Control', 'no-store').json({ ...result, message: result.view_all_wallets ? 'All-user wallet visibility enabled' : 'Wallet visibility limited to own wallet' });
});
