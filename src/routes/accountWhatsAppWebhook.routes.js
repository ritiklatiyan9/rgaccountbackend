import express from 'express';
import asyncHandler from '../utils/asyncHandler.js';
import {handleAccountWhatsAppSnsEnvelope} from '../services/accountWhatsAppInbound.service.js';

export function createAccountWhatsAppWebhookRouter(deps={}) {
 const router=express.Router();
 // SNS normally sends text/plain; the app's JSON parser may already have
 // handled application/json. Both forms pass the identical signature check.
 router.post('/',express.text({type:['text/plain','application/json'],limit:'1mb'}),asyncHandler(async(req,res)=>{
  const result=await handleAccountWhatsAppSnsEnvelope(req.body,deps);
  res.set('Cache-Control','no-store').json({ok:true,...result});
 }));
 return router;
}
export default createAccountWhatsAppWebhookRouter();
