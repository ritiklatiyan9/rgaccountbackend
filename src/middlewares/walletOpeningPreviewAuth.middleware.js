import {createHash} from 'node:crypto';
import {createAuthMiddleware,createAuthStateLoader} from './auth.middleware.js';

// The reader always uses the user's existing Accounts session. Upstream mode
// validates with the hosted application. Local mode is an explicit opt-in for
// a reader configured with that issuer's JWT verifier and auth-state database.
// It uses production authentication unchanged, including current session,
// token-version and app-access checks; no token is minted or auth result cached.
export const WALLET_OPENING_AUTH_ORIGIN='https://rgaccountbackend.onrender.com';
export function createWalletOpeningPreviewAuth({database,request=fetch,mode='upstream',verify}){
  if(mode==='local'){
    // Share only concurrent DB checks inside this reader. Never fall back to
    // upstream after a rejected local token/session or unavailable auth DB.
    return createAuthMiddleware({verify,loadState:createAuthStateLoader(database)});
  }
  if(mode!=='upstream')throw new TypeError('Wallet opening auth mode must be local or upstream.');
  const pendingChecks=new Map();
  const checkUpstream=async(authorization,session,historySite)=>{
    try{
      const headers={Authorization:authorization};
      if(session)headers['X-Session-ID']=session;
      const response=await request(`${WALLET_OPENING_AUTH_ORIGIN}/auth/me`,{method:'GET',headers,redirect:'error',signal:AbortSignal.timeout(15000)});
      if(response.status===401||response.status===403)return {status:response.status,message:'The Accounts session must be valid to read wallet openings.'};
      if(!response.ok)return {status:503,message:'Accounts session verification is temporarily unavailable.'};
      const remote=(await response.json())?.user;
      if(!Number.isSafeInteger(Number(remote?.id))||Number(remote.id)<=0||!remote.organization_id)return {status:503,message:'Accounts session verification returned an invalid user.'};
      const row=(await (historySite == null
        ? database.query('SELECT id,name,role,is_active,organization_id FROM users WHERE id=$1 AND organization_id=$2',[Number(remote.id),Number(remote.organization_id)])
        : database.query(`SELECT u.id,u.name,u.role,u.is_active,u.organization_id,
          EXISTS(SELECT 1 FROM sites s WHERE s.id=$3
            AND (u.role='super_admin' OR s.organization_id=u.organization_id)
            AND (u.role IN ('admin','super_admin') OR EXISTS(SELECT 1 FROM user_sites us WHERE us.site_id=s.id AND us.user_id=u.id))) AS history_site_allowed,
          CASE WHEN u.role='sub_admin' THEN COALESCE((SELECT jsonb_agg(p) FROM user_permissions p WHERE p.user_id=u.id),'[]'::jsonb)
            ELSE '[]'::jsonb END AS history_permissions
          FROM users u WHERE u.id=$1 AND u.organization_id=$2`,[Number(remote.id),Number(remote.organization_id),historySite]))).rows[0];
      if(!row?.is_active||row.role!==remote.role)return {status:401,message:'The Accounts user is no longer active in this organization.'};
      const {history_site_allowed,history_permissions,...user}=row;
      return {user,...(historySite == null ? {} : {historyAccess:{siteId:historySite,userId:Number(user.id),role:user.role,
        organizationId:Number(user.organization_id),site_allowed:history_site_allowed===true,permissions:history_permissions||[]}})};
    }catch{
      return {status:503,message:'Accounts session verification is temporarily unavailable.'};
    }
  };
  return async(req,res,next)=>{
    const authorization=req.header('Authorization');
    if(typeof authorization!=='string'||!authorization.startsWith('Bearer '))return res.status(401).json({message:'No token provided'});
    const session=req.header('X-Session-ID');
    const site=req.query?.site_id;
    const historySite=req.route?.path==='/approvals/history' && /^\d+$/.test(String(site)) && Number.isSafeInteger(Number(site)) && Number(site)>0 && Number(site)<=2147483647 ? Number(site) : null;
    // Share only work already running for the exact credential/session pair.
    // Store a digest, not credentials, as the key. Settlement removes it before
    // another request can use the result, including denial and network errors.
    const key=createHash('sha256').update(JSON.stringify([authorization,session??null,historySite])).digest('hex');
    let pending=pendingChecks.get(key);
    if(!pending){
      pending=Promise.resolve().then(()=>checkUpstream(authorization,session,historySite)).finally(()=>pendingChecks.delete(key));
      pendingChecks.set(key,pending);
    }
    const result=await pending;
    if(result.status)return res.status(result.status).json({message:result.message});
    req.user={...result.user,permissionsByModule:new Map()};
    req.authenticatedUser={...result.user};
    // This proof is request-scoped and site-bound. It reuses the current DB
    // check already required by the bridge, never an earlier auth response.
    if(result.historyAccess)req.requestHistoryAccess=structuredClone(result.historyAccess);
    next();
  };
}
