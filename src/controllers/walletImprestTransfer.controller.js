import asyncHandler from '../utils/asyncHandler.js';
import {
  walletImprestAccess, walletImprestParticipants, listWalletImprestTransfers,
  createWalletImprestTransfer, resolveWalletImprestTransfer,
} from '../services/walletImprestTransfer.service.js';
import { clearCacheByPrefixes } from '../config/cache.js';

export const authorizeWalletImprestRead=asyncHandler(async(req,res,next)=>{
  req.walletImprestAccess=await walletImprestAccess(req.user,req.query.site_id);
  const {actor,siteId}=req.walletImprestAccess;
  req.cacheDataScope=`${actor.organization_id}:${siteId}:${actor.role}:${actor.wallet_view_all===true}`;
  next();
});
export const participants=asyncHandler(async(req,res)=>{
  res.json(await walletImprestParticipants(req.user,req.query,undefined,req.walletImprestAccess));
});
export const list=asyncHandler(async(req,res)=>{
  res.json(await listWalletImprestTransfers(req.user,req.query,undefined,req.walletImprestAccess));
});
async function invalidate() {
  // Complete invalidation before acknowledging a mutation. Optional Redis
  // failure never rolls back an already committed financial transaction.
  await clearCacheByPrefixes(['wallet-imprest|','imprest|','balance-sheet|','site-profit|','dashboard:','management-analytics|','reports|']).catch(()=>{});
}
export const create=asyncHandler(async(req,res)=>{
  const result=await createWalletImprestTransfer(req.user,req.body);
  if(!result.replayed) await invalidate();
  res.status(result.replayed?200:201).json(result);
});
export const resolve=action=>asyncHandler(async(req,res)=>{
  const result=await resolveWalletImprestTransfer(req.user,req.params.id,action,req.body);
  if(!result.replayed) await invalidate();
  res.json(result);
});
