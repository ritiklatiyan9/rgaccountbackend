import express from 'express';
import authMiddleware from '../middlewares/auth.middleware.js';
import requireRole from '../middlewares/role.middleware.js';
import asyncHandler from '../utils/asyncHandler.js';
import {listAccountWhatsAppInbox,getAccountWhatsAppInboxMessages,markAccountWhatsAppInboxRead,sendAccountWhatsAppInboxReply,getAccountWhatsAppInboxReadiness} from '../services/accountWhatsAppInbox.service.js';

export function createAccountWhatsAppInboxRouter({authenticate=authMiddleware,...deps}={}) {
 const router=express.Router();
 router.use(authenticate,requireRole('admin'));
 router.get('/readiness',asyncHandler(async(req,res)=>res.set('Cache-Control','no-store').json(await getAccountWhatsAppInboxReadiness(req.user,deps))));
 router.get('/',asyncHandler(async(req,res)=>res.set('Cache-Control','no-store').json(await listAccountWhatsAppInbox(req.user,req.query,deps))));
 router.get('/:id/messages',asyncHandler(async(req,res)=>res.set('Cache-Control','no-store').json(await getAccountWhatsAppInboxMessages(req.user,req.params.id,req.query,deps))));
 router.post('/:id/read',asyncHandler(async(req,res)=>res.json(await markAccountWhatsAppInboxRead(req.user,req.params.id,{...deps,readThroughId:req.body?.through_message_id}))));
 router.post('/:id/replies',asyncHandler(async(req,res)=>res.status(202).json(await sendAccountWhatsAppInboxReply(req.user,req.params.id,req.body||{},deps))));
 return router;
}
export default createAccountWhatsAppInboxRouter();
