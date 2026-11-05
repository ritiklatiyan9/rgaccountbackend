import { warmRequestHistory } from '../src/services/requestHistoryWarmup.service.js';
import { listRequestHistory } from '../src/controllers/approval.controller.js';
import requireRole from '../src/middlewares/role.middleware.js';
import { historyReadLimit, historyTransport, historyErrors } from '../src/middlewares/historyTransport.middleware.js';
// Authenticated, loopback-only reader for wallet balances, openings and amount explanations. Financial modules
// keep their normal API; there are no write endpoints or startup migrations.
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import pool,{getDatabasePoolStats} from '../src/config/db.js';
import {createWalletOpeningPreviewAuth} from '../src/middlewares/walletOpeningPreviewAuth.middleware.js';
import {requestPerformance} from '../src/utils/requestPerformance.js';
import errorMiddleware from '../src/middlewares/error.middleware.js';
import {summary,workspace,holders,userDetail,reportingOpenings,amountBreakdown,history,transfers,assignedTransactions} from '../src/controllers/loyaltyVault.controller.js';
import { imprestHandoverSummary } from '../src/controllers/imprestHandoverSummary.controller.js';
import { requireImprestReadAccess } from '../src/middlewares/imprestPermission.middleware.js';
const app=express();
const mode=process.env.WALLET_OPENING_AUTH_MODE;
const verifySession=['upstream','local'].includes(mode)
  ? createWalletOpeningPreviewAuth({database:pool,mode})
  : (_req,res)=>res.status(503).json({message:'Wallet reader authentication is not configured.'});
const auth=(req,res,next)=>{
  const started=performance.now();
  return verifySession(req,res,error=>{
    const elapsed=performance.now()-started;
    res.setHeader('Server-Timing',`auth;dur=${elapsed.toFixed(1)}`);
    if(process.env.API_PERFORMANCE_LOG==='true')console.log(JSON.stringify({type:'wallet-auth-timing',route:req.route.path,mode,duration_ms:Math.round(elapsed)}));
    next(error);
  });
};
app.use(requestPerformance({poolStats:getDatabasePoolStats}));
app.use(cors({origin:['http://127.0.0.1:5174','http://localhost:5174'],credentials:true,exposedHeaders:['Server-Timing']}));
app.get('/health',(_req,res)=>res.json({service:'wallet-opening-reader',read_only:true,request_history_version:4}));
app.get('/approvals/history',auth,requireRole('admin','sub_admin'),historyReadLimit,historyTransport,listRequestHistory,historyErrors);
app.get('/wallet',auth,summary);
app.get('/wallet/workspace',auth,workspace);
app.get('/wallet/holders',auth,holders);
app.get('/wallet/users/:id',auth,userDetail);
app.get('/wallet/reporting-openings',auth,reportingOpenings);
app.get('/wallet/users/:id/breakdown',auth,amountBreakdown);
app.get('/imprest/handover-summary',auth,requireImprestReadAccess,imprestHandoverSummary);
for(const prefix of ['/wallet','/wallet/overall']){
  app.get(`${prefix}/history`,auth,history);
  app.get(`${prefix}/transfers`,auth,transfers);
  app.get(`${prefix}/transactions`,auth,assignedTransactions);
}
app.use(errorMiddleware);
const port=Number(process.env.WALLET_OPENING_PREVIEW_PORT||8003);
// Establish the two bounded read connections before advertising readiness.
// This warms transport only; every wallet balance is still read from the DB.
await Promise.all([pool.query('SELECT 1'),pool.query('SELECT 1'),warmRequestHistory(pool)]);
const server=app.listen(port,'127.0.0.1',()=>console.log(`Wallet opening reader ready on http://127.0.0.1:${port}`));
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>server.close(()=>pool.end().finally(()=>process.exit(0))));
