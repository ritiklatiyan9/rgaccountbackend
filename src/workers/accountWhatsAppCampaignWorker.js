import { pathToFileURL } from 'node:url';
import pool from '../config/db.js';
import { drainAccountWhatsAppCampaigns } from '../services/accountWhatsAppCampaigns.service.js';

let timer;
let started=false;
let stopped=true;
let generation=0;
/** This worker advances only recipient rows created by an explicit manual send.
 * It never submits templates, schedules a campaign or starts event reminders. */
export function startAccountWhatsAppCampaignWorker({interval_ms=2000,...options}={}) {
 if(started||process.env.NODE_TEST_CONTEXT)return;
 started=true;stopped=false;
 const epoch=++generation;
 const activeDelay=Math.min(10000,Math.max(500,Number(interval_ms)||2000));
 let nextDelay=activeDelay;
 const tick=async()=>{
  if(stopped||epoch!==generation)return;
  try{
   const result=await drainAccountWhatsAppCampaigns(options);
   nextDelay=result.processed>0?activeDelay:Math.min(10000,nextDelay*2);
  }catch(error){nextDelay=Math.min(10000,nextDelay*2);console.error('[account-whatsapp-campaigns]',error.message);}
  finally{if(!stopped&&epoch===generation){timer=setTimeout(tick,nextDelay);timer.unref();}}
 };
 void tick();
}
export function stopAccountWhatsAppCampaignWorker(){stopped=true;started=false;generation++;clearTimeout(timer);}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 startAccountWhatsAppCampaignWorker();
 for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>{stopAccountWhatsAppCampaignWorker();pool.end().finally(()=>process.exit(0));});
}
