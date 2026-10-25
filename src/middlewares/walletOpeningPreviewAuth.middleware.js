// The local report reader uses the user's existing hosted Accounts session.
// Validate it at that same application's normal auth endpoint, then recheck
// local organization/role access. Never mint a token or relax session checks.
export const WALLET_OPENING_AUTH_ORIGIN='https://rgaccountbackend.onrender.com';
export function createWalletOpeningPreviewAuth({database,request=fetch}){
  return async(req,res,next)=>{
    const authorization=req.header('Authorization');
    if(typeof authorization!=='string'||!authorization.startsWith('Bearer '))return res.status(401).json({message:'No token provided'});
    try{
      const headers={Authorization:authorization};
      const session=req.header('X-Session-ID');
      if(session)headers['X-Session-ID']=session;
      const response=await request(`${WALLET_OPENING_AUTH_ORIGIN}/auth/me`,{method:'GET',headers,redirect:'error',signal:AbortSignal.timeout(15000)});
      if(response.status===401||response.status===403)return res.status(response.status).json({message:'The Accounts session must be valid to read wallet openings.'});
      if(!response.ok)return res.status(503).json({message:'Accounts session verification is temporarily unavailable.'});
      const remote=(await response.json())?.user;
      if(!Number.isSafeInteger(Number(remote?.id))||Number(remote.id)<=0||!remote.organization_id)return res.status(503).json({message:'Accounts session verification returned an invalid user.'});
      const user=(await database.query('SELECT id,name,role,is_active,organization_id FROM users WHERE id=$1 AND organization_id=$2',[Number(remote.id),Number(remote.organization_id)])).rows[0];
      if(!user?.is_active||user.role!==remote.role)return res.status(401).json({message:'The Accounts user is no longer active in this organization.'});
      req.user={...user,permissionsByModule:new Map()};req.authenticatedUser=user;next();
    }catch{
      return res.status(503).json({message:'Accounts session verification is temporarily unavailable.'});
    }
  };
}
