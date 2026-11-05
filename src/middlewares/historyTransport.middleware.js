import { gzip } from 'node:zlib';
import { promisify } from 'node:util';
import createRateLimiter from './rateLimit.middleware.js';

const compress = promisify(gzip);
const rateLimit = createRateLimiter({windowMs:60000,max:180,keyPrefix:'request-history:',
  keyGenerator:req=>`${req.user.organization_id}:${req.user.id}`});
const active = new Map();
export function historyReadLimit(req,res,next) {
  return rateLimit(req,res,()=>{
    const key = `${req.user.organization_id}:${req.user.id}`;
    if ((active.get(key) || 0) >= 8) {
      res.set('Retry-After','1');
      return res.status(429).json({message:'Too many active history reads. Please retry shortly.'});
    }
    active.set(key,(active.get(key) || 0)+1);
    let released = false;
    const release = () => { if (released) return; released=true; const count=(active.get(key)||1)-1;
      if(count)active.set(key,count);else active.delete(key); };
    res.once('finish',release);res.once('close',release);
    next();
  });
}

/** Compress only this private read surface, after projection and serialization. */
export function historyTransport(req,res,next) {
  res.set('Cache-Control','private, no-store');
  res.vary('Accept-Encoding');
  if (!req.headers['accept-encoding'] || !req.acceptsEncodings('gzip')) return next();
  const original = res.json.bind(res);
  res.json = body => {
    let json;
    try { json = JSON.stringify(body); } catch(error) { next(error); return res; }
    if (Buffer.byteLength(json)<1024) return original(body);
    compress(json,{level:3}).then(bytes=>{
      if(res.destroyed)return;
      res.set('Content-Type','application/json; charset=utf-8');
      res.set('Content-Encoding','gzip');res.set('Content-Length',String(bytes.length));
      res.end(bytes);
    }).catch(next);
    return res;
  };
  next();
}

export function historyErrors(error,_req,res,next) {
  if (!['HISTORY_QUERY_TIMEOUT','HISTORY_BUSY','HISTORY_CURSOR_INVALID'].includes(error.code)) return next(error);
  if (error.statusCode === 503) res.set('Retry-After','2');
  return res.status(error.statusCode).json({message:error.message,code:error.code});
}
