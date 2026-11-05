import {
 createCashflowTransfer,transferEligibility,transferDestinations,listCashflowTransfers,
 getCashflowTransfer,getTransferSettings,updateTransferSettings,
} from '../services/cashflowTransfer.service.js';

// A small boundary keeps financial error codes stable without exposing SQL or
// acknowledging an uncertain commit as a new request. Clients retain their key.
const handle=run=>async(req,res,next)=>{
 try {await run(req,res);} catch(error) {
  if(error.statusCode) {
   if(error.statusCode===503) res.set('Retry-After','2');
   return res.status(error.statusCode).json({code:error.code,message:error.message});
  }
  if(['42P01','42703'].includes(error.code)) return res.status(503).json({code:'TRANSFER_SCHEMA_NOT_READY',message:'Money transfers require the Cashflow transfer migration. Contact your administrator.'});
  if(error.constraint==='cashflow_transfer_immutable') return res.status(409).json({code:'TRANSFER_IMMUTABLE',message:'Completed transfer entries and their source receipts cannot be edited or deleted.'});
  next(error);
 }
};
export const createTransfer=handle(async(req,res)=>{
 const result=await createCashflowTransfer(req.user,req.body);
 res.status(result.replayed?200:201).json(result);
});
export const eligibility=handle(async(req,res)=>res.json(await transferEligibility(req.user,req.query)));
export const destinations=handle(async(req,res)=>res.json(await transferDestinations(req.user,req.query)));
export const listTransfers=handle(async(req,res)=>res.json(await listCashflowTransfers(req.user,req.query)));
export const getTransfer=handle(async(req,res)=>res.json(await getCashflowTransfer(req.user,req.params.id)));
export const getSettings=handle(async(req,res)=>res.json(await getTransferSettings(req.user,req.query)));
export const putSettings=handle(async(req,res)=>res.json(await updateTransferSettings(req.user,req.body)));
