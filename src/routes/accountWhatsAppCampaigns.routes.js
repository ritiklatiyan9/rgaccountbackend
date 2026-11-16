import express from 'express';
import multer from 'multer';
import authMiddleware from '../middlewares/auth.middleware.js';
import requireRole from '../middlewares/role.middleware.js';
import asyncHandler from '../utils/asyncHandler.js';
import {
 CAMPAIGN_DOCUMENT_MAX_BYTES, listAccountWhatsAppCampaigns, createAccountWhatsAppCampaign,
 getAccountWhatsAppCampaign, updateAccountWhatsAppCampaign, saveAccountWhatsAppCampaignDocument,
 downloadAccountWhatsAppCampaignDocument, submitAccountWhatsAppCampaignTemplate,
 refreshAccountWhatsAppCampaignTemplate, previewAccountWhatsAppCampaignAudience,
 sendAccountWhatsAppCampaign, pauseAccountWhatsAppCampaign,
} from '../services/accountWhatsAppCampaigns.service.js';

/** Mounted at /account-whatsapp/campaigns. Authentication can be supplied by the
 * narrow local preview's normal upstream-session bridge; production uses auth. */
export function createAccountWhatsAppCampaignsRouter({authenticate=authMiddleware,...dependencies}={}) {
 const router=express.Router();
 router.use(authenticate,requireRole('admin'));
 const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:CAMPAIGN_DOCUMENT_MAX_BYTES,files:1,fields:4}}).single('document');
 router.get('/',asyncHandler(async(req,res)=>res.set('Cache-Control','no-store').json(await listAccountWhatsAppCampaigns(req.user,req.query,dependencies))));
 router.post('/',asyncHandler(async(req,res)=>res.status(201).json(await createAccountWhatsAppCampaign(req.user,req.body||{},dependencies))));
 router.get('/:id',asyncHandler(async(req,res)=>res.set('Cache-Control','no-store').json(await getAccountWhatsAppCampaign(req.user,req.params.id,dependencies))));
 router.patch('/:id',asyncHandler(async(req,res)=>res.json(await updateAccountWhatsAppCampaign(req.user,req.params.id,req.body||{},dependencies))));
 router.post('/:id/document',(req,res,next)=>upload(req,res,error=>{
  if(!error)return next();
  const message=error.code==='LIMIT_FILE_SIZE'?'Attach a PDF of up to 20 MB':error.message;
  res.status(400).json({message});
 }),asyncHandler(async(req,res)=>res.json(await saveAccountWhatsAppCampaignDocument(req.user,req.params.id,req.file,req.body||{},dependencies))));
 router.get('/:id/document',asyncHandler(async(req,res)=>{
  const doc=await downloadAccountWhatsAppCampaignDocument(req.user,req.params.id,dependencies);
  res.set({'Cache-Control':'private, no-store','Content-Type':'application/pdf','Content-Disposition':'attachment; filename="INVITATION.pdf"','X-Content-Type-Options':'nosniff'}).send(doc.buffer);
 }));
 router.post('/:id/submit-template',asyncHandler(async(req,res)=>res.json(await submitAccountWhatsAppCampaignTemplate(req.user,req.params.id,req.body||{},dependencies))));
 router.post('/:id/refresh-template',asyncHandler(async(req,res)=>res.json(await refreshAccountWhatsAppCampaignTemplate(req.user,req.params.id,req.body||{},dependencies))));
 router.get('/:id/audience',asyncHandler(async(req,res)=>res.set('Cache-Control','no-store').json(await previewAccountWhatsAppCampaignAudience(req.user,req.params.id,req.query,dependencies))));
 router.post('/:id/send',asyncHandler(async(req,res)=>res.status(202).json(await sendAccountWhatsAppCampaign(req.user,req.params.id,req.body||{},dependencies))));
 router.post('/:id/pause',asyncHandler(async(req,res)=>res.json(await pauseAccountWhatsAppCampaign(req.user,req.params.id,req.body||{},dependencies))));
 return router;
}
export default createAccountWhatsAppCampaignsRouter();
