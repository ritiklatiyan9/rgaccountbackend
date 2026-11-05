import { historyFingerprint } from './requestHistoryCursor.js';
import pg from 'pg';

const flights = new WeakMap();
const concurrency=Math.max(1,Math.min(4,Number.parseInt(process.env.HISTORY_QUERY_CONCURRENCY||'2',10)||2));
const queue=[];let active=0;
const busy=()=>Object.assign(new Error('History is busy. Please retry shortly.'),{statusCode:503,code:'HISTORY_BUSY'});
function acquire(){
  const release=()=>{active--;const next=queue.shift();if(next){clearTimeout(next.timer);active++;next.resolve(release);}};
  if(active<concurrency){active++;return Promise.resolve(release);}
  if(queue.length>=32)return Promise.reject(busy());
  return new Promise((resolve,reject)=>{
    const entry={resolve,timer:setTimeout(()=>{const index=queue.indexOf(entry);if(index>=0)queue.splice(index,1);reject(busy());},2000)};
    queue.push(entry);
  });
}
export const historyReadQueueStats=()=>({active,queued:queue.length,concurrency,maxPending:32});
/** Only concurrent, identical reads share work. Completed financial data is never cached. */
export function runHistoryQuery(db, sql, values, scope) {
  let pending = flights.get(db);
  if (!pending) { pending = new Map(); flights.set(db, pending); }
  const key = scope || historyFingerprint([sql, values]);
  const copy = result => ({ rows: structuredClone(result.rows) });
  if (pending.has(key)) return pending.get(key).then(copy);
  if (pending.size >= 64) return Promise.reject(Object.assign(new Error('History is busy. Please retry shortly.'), { statusCode: 503, code: 'HISTORY_BUSY' }));
  // pg-pool releases errored clients with an error, which closes the connection
  // and terminates timed-out work. Fixture adapters keep their string API.
  const nativePool = db instanceof pg.Pool;
  // Batch arrivals from one event-loop turn before a local/CPU-heavy adapter
  // begins, so sibling requests can share the same unfinished read.
  const operation = new Promise(resolve => setImmediate(resolve)).then(async() => {
    const release=await acquire();
    try{return await (nativePool?db.query({text:sql,values,query_timeout:5000}):db.query(sql,values));}
    finally{release();}
  })
    .catch(error => {
      if (/timeout|canceling statement/i.test(error.message) || error.code === '57014') {
        throw Object.assign(new Error('History query took too long. Narrow the filters and retry.'), { statusCode: 503, code: 'HISTORY_QUERY_TIMEOUT' });
      }
      throw error;
    }).finally(() => pending.delete(key));
  pending.set(key, operation);
  return operation.then(copy);
}
