import { walletError } from './wallet.service.js';

const busy=()=>Object.assign(walletError('Cash Wallet is busy. Retry this request with the same request key in a few seconds.',503),{
  code:'WALLET_WRITE_BUSY',retryAfterSeconds:2,
});

// Waiting for a site/account lock must not consume every pg pool client.
// Admission happens before checkout and the bounded queue stores no balances
// or financial state. PostgreSQL remains responsible for posting/locking.
export function createWalletWriteAdmission({limit=2,maxPending=32,queueTimeoutMs=5000}={}) {
  if(!Number.isInteger(limit)||limit<1||!Number.isInteger(maxPending)||maxPending<0
    ||!Number.isInteger(queueTimeoutMs)||queueTimeoutMs<1) throw new Error('Invalid wallet write admission settings');
  let active=0;
  const waiting=[];
  const permit=()=>{
    let released=false;
    return ()=>{
      if(released) return;
      released=true;
      const next=waiting.shift();
      if(next) {clearTimeout(next.timer);next.resolve(permit());}
      else active-=1;
    };
  };
  return {
    acquire() {
      if(active<limit) {active+=1;return Promise.resolve(permit());}
      if(waiting.length>=maxPending) return Promise.reject(busy());
      return new Promise((resolve,reject)=>{
        const entry={resolve,timer:null};
        entry.timer=setTimeout(()=>{
          const index=waiting.indexOf(entry);
          if(index<0) return;
          waiting.splice(index,1);reject(busy());
        },queueTimeoutMs);
        waiting.push(entry);
      });
    },
    stats:()=>({active,pending:waiting.length,limit,maxPending}),
  };
}

const admissions=new WeakMap();
const setting=(value,fallback,max)=>{
  const parsed=Number(value);
  return Number.isInteger(parsed)&&parsed>0?Math.min(parsed,max):fallback;
};
function admissionFor(database) {
  let admission=admissions.get(database);
  if(!admission) {
    // Reporting already admits a maximum of two reads. Default writes admit
    // two clients, with a cap of three, leaving capacity for login and other
    // APIs in the normal ten-client pool. Tiny pools admit one writer.
    const poolCapacity=setting(database.options?.max,10,100);
    const requested=setting(process.env.WALLET_WRITE_CONCURRENCY,2,3);
    const limit=Math.min(requested,Math.max(1,poolCapacity-2));
    admission=createWalletWriteAdmission({limit,
      maxPending:setting(process.env.WALLET_WRITE_MAX_PENDING,32,128),
      queueTimeoutMs:setting(process.env.WALLET_WRITE_QUEUE_TIMEOUT_MS,5000,10000)});
    admissions.set(database,admission);
  }
  return admission;
}
export const acquireWalletWriteSlot=database=>admissionFor(database).acquire();
export const walletWriteAdmissionStats=database=>admissionFor(database).stats();
