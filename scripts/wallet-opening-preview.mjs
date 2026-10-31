// Authenticated, loopback-only reader for openings and amount explanations. Financial modules
// keep their normal API; there are no write endpoints or startup migrations.
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import pool from '../src/config/db.js';
import {createWalletOpeningPreviewAuth} from '../src/middlewares/walletOpeningPreviewAuth.middleware.js';
import {reportingOpenings,amountBreakdown,history,transfers,assignedTransactions} from '../src/controllers/loyaltyVault.controller.js';
const app=express();
const auth=process.env.WALLET_OPENING_AUTH_MODE==='upstream'
  ? createWalletOpeningPreviewAuth({database:pool})
  : (_req,res)=>res.status(503).json({message:'Wallet opening is saved; existing-session verification needs approval before activation.'});
app.use((req,res,next)=>{const json=res.json.bind(res);res.json=body=>{if(res.statusCode===401)console.log('Wallet opening authentication:',body.message);return json(body);};res.once('finish',()=>console.log(`Wallet opening reader ${req.method} ${req.path}: ${res.statusCode}`));next();});
app.use(cors({origin:['http://127.0.0.1:5174','http://localhost:5174'],credentials:true}));
app.get('/health',(_req,res)=>res.json({service:'wallet-opening-reader',read_only:true}));
app.get('/wallet/reporting-openings',auth,reportingOpenings);
app.get('/wallet/users/:id/breakdown',auth,amountBreakdown);
for(const prefix of ['/wallet','/wallet/overall']){
  app.get(`${prefix}/history`,auth,history);
  app.get(`${prefix}/transfers`,auth,transfers);
  app.get(`${prefix}/transactions`,auth,assignedTransactions);
}
app.use((error,_req,res,_next)=>{console.error('Wallet opening read failed:',error.code||error.name,error.message);res.status(error.statusCode||500).json({message:error.statusCode?error.message:'Wallet reporting opening unavailable.'});});
const server=app.listen(Number(process.env.WALLET_OPENING_PREVIEW_PORT||8003),'127.0.0.1',()=>console.log('Wallet opening reader ready on http://127.0.0.1:8003'));
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>server.close(()=>pool.end().finally(()=>process.exit(0))));
