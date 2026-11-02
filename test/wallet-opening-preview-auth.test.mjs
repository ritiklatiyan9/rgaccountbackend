import test from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import {createWalletOpeningPreviewAuth,WALLET_OPENING_AUTH_ORIGIN} from '../src/middlewares/walletOpeningPreviewAuth.middleware.js';
const user={id:7,name:'Admin',role:'admin',is_active:true,organization_id:1};
async function invoke({status=200,remote=user,local=user,offline=false,token=true}={}){
  const calls=[];let queries=0,next=false;
  const req={header:name=>name==='Authorization'?(token?'Bearer existing-session':undefined):name==='X-Session-ID'?'123':undefined};
  const res={statusCode:200,status(code){this.statusCode=code;return this;},json(body){this.body=body;return this;}};
  const auth=createWalletOpeningPreviewAuth({database:{query:async()=>{queries++;return {rows:local?[local]:[]};}},request:async(url,options)=>{calls.push({url,options});if(offline)throw new Error('offline');return {status,ok:status===200,json:async()=>({user:remote})};}});
  await auth(req,res,error=>{if(error)throw error;next=true;});
  return {req,res,calls,queries,next};
}
test('local opening reader validates the existing session only at the configured Accounts API and rechecks local access',async()=>{
  const value=await invoke();assert.equal(value.next,true);assert.equal(value.req.user.id,7);
  assert.equal(value.calls[0].url,`${WALLET_OPENING_AUTH_ORIGIN}/auth/me`);
  assert.equal(value.calls[0].options.headers.Authorization,'Bearer existing-session');
  assert.equal(value.calls[0].options.headers['X-Session-ID'],'123');assert.equal(value.calls[0].options.redirect,'error');
});
test('invalid, expired, absent or unreachable upstream sessions cannot read local wallet metadata',async()=>{
  for(const args of [{status:401},{status:403},{status:503},{offline:true},{token:false},{remote:{id:7}}]){
    const value=await invoke(args);assert.equal(value.next,false);assert.equal(value.queries,0);assert.ok(value.res.statusCode>=400);
  }
});
test('a revoked local user or role mismatch remains denied after upstream verification',async()=>{
  for(const local of [null,{...user,is_active:false},{...user,role:'sub_admin'}])assert.equal((await invoke({local})).next,false);
});

function upstreamReader({request=async()=>({status:200,ok:true,json:async()=>({user})}),load=async()=>({rows:[user]})}={}){
  let remoteCalls=0,queries=0;
  const auth=createWalletOpeningPreviewAuth({
    database:{query:(...args)=>{queries++;return load(...args);}},
    request:(...args)=>{remoteCalls++;return request(...args);},
  });
  return {
    get remoteCalls(){return remoteCalls;},
    get queries(){return queries;},
    async invoke(headers={}){
      const requestHeaders={Authorization:'Bearer existing-session','X-Session-ID':'123',...headers};
      const req={header:name=>requestHeaders[name]};
      const res={statusCode:200,status(code){this.statusCode=code;return this;},json(body){this.body=body;return this;}};
      let allowed=false;
      await auth(req,res,error=>{assert.ifError(error);allowed=true;});
      return {req,res,allowed};
    },
  };
}

test('upstream mode shares only simultaneous verification and gives each request separate permission state',async()=>{
  let release,started;
  const gate=new Promise(resolve=>{release=resolve;});
  const requested=new Promise(resolve=>{started=resolve;});
  const reader=upstreamReader({request:async()=>{started();await gate;return {status:200,ok:true,json:async()=>({user})};}});
  const first=reader.invoke();
  const second=reader.invoke();
  await requested;
  assert.equal(reader.remoteCalls,1);
  release();
  const results=await Promise.all([first,second]);
  assert.ok(results.every(result=>result.allowed));
  assert.equal(reader.queries,1);
  assert.notEqual(results[0].req.user.permissionsByModule,results[1].req.user.permissionsByModule);
  assert.notEqual(results[0].req.authenticatedUser,results[1].req.authenticatedUser);
  await reader.invoke();
  assert.equal(reader.remoteCalls,2,'a completed auth result must never be reused');
  assert.equal(reader.queries,2);
});

test('upstream mode does not share verification across credentials or session context',async()=>{
  const reader=upstreamReader();
  const results=await Promise.all([
    reader.invoke(),
    reader.invoke({Authorization:'Bearer another-session'}),
    reader.invoke({'X-Session-ID':'124'}),
    reader.invoke({'X-Session-ID':undefined}),
  ]);
  assert.ok(results.every(result=>result.allowed));
  assert.equal(reader.remoteCalls,4);
  assert.equal(reader.queries,4);
});

test('upstream mode immediately observes remote revocation and local deactivation after a completed check',async()=>{
  let status=200,current=user;
  const reader=upstreamReader({request:async()=>({status,ok:status===200,json:async()=>({user})}),load:async()=>({rows:[current]})});
  assert.equal((await reader.invoke()).allowed,true);
  status=401;
  assert.equal((await reader.invoke()).res.statusCode,401);
  assert.equal(reader.queries,1,'upstream denial must not query local access');
  status=200;
  current={...user,is_active:false};
  assert.equal((await reader.invoke()).res.statusCode,401);
  assert.equal(reader.remoteCalls,3);
  assert.equal(reader.queries,2);
});

test('upstream mode evicts denied and synchronously failed checks so a later request can recover',async()=>{
  for(const failWith of ['throw','denied','unavailable']){
    let failing=true;
    const reader=upstreamReader({request:()=>{
      if(failing&&failWith==='throw')throw new Error('network failure');
      const status=failing?(failWith==='denied'?401:503):200;
      return {status,ok:status===200,json:async()=>({user})};
    }});
    const results=await Promise.all([reader.invoke(),reader.invoke()]);
    assert.ok(results.every(result=>!result.allowed&&result.res.statusCode>=400));
    assert.equal(reader.remoteCalls,1);
    assert.equal(reader.queries,0);
    failing=false;
    assert.equal((await reader.invoke()).allowed,true);
    assert.equal(reader.remoteCalls,2);
  }
});

// Synthetic tokens use a test-only key, independent of environment credentials.
const testKey='wallet-preview-auth-unit-test-key';
const claims={id:7,role:'admin',version:4,app:'accounts'};
const authUser={...user,token_version:4,can_login_accounts:true,can_login_booking_accounts:true,session_id:123,session_logout_time:null};
const tokenFor=(payload=claims,key=testKey)=>jwt.sign(payload,key);

function localReader({load=async()=>({rows:[authUser]})}={}){
  const queries=[];
  let remoteCalls=0;
  const auth=createWalletOpeningPreviewAuth({
    mode:'local',
    database:{query:async(sql,params)=>{queries.push({sql,params});return load(sql,params);}},
    verify:token=>jwt.verify(token,testKey),
    request:async()=>{remoteCalls++;throw new Error('Local authentication must not call upstream');},
  });
  return {
    queries,
    get remoteCalls(){return remoteCalls;},
    async invoke({token=tokenFor(),headers={}}={}){
      const requestHeaders={Authorization:token?`Bearer ${token}`:undefined,'X-Session-ID':'123',Origin:'http://localhost:5174',...headers};
      const req={header:name=>requestHeaders[name]};
      const res={statusCode:200,status(code){this.statusCode=code;return this;},json(body){this.body=body;return this;}};
      let allowed=false,error;
      await auth(req,res,failure=>{if(failure)error=failure;else allowed=true;});
      return {req,res,allowed,error};
    },
  };
}

test('explicit local mode checks the existing JWT and auth state in one query with no hosted request',async()=>{
  const reader=localReader();
  const result=await reader.invoke();
  assert.equal(result.allowed,true);
  assert.equal(reader.queries.length,1);
  assert.deepEqual(reader.queries[0].params,[7,123]);
  assert.match(reader.queries[0].sql,/LEFT JOIN user_sessions/);
  assert.equal(reader.remoteCalls,0);
  assert.equal(result.req.sessionId,123);
  assert.equal(result.req.appContext,'accounts');
  assert.equal(result.req.authenticatedUser,authUser);
  assert.ok(result.req.user.permissionsByModule instanceof Map);
});

test('local mode rejects missing, invalid, expired and wrong-issuer tokens before DB access without fallback',async()=>{
  for(const token of [null,'invalid',tokenFor({...claims,exp:1}),tokenFor(claims,'another-test-issuer')]){
    const reader=localReader();
    const result=await reader.invoke({token});
    assert.equal(result.allowed,false);
    assert.equal(result.res.statusCode,401);
    assert.equal(reader.queries.length,0);
    assert.equal(reader.remoteCalls,0);
  }
});

test('local mode preserves production checks for deactivation, revoked token version and invalid sessions',async()=>{
  for(const current of [null,{...authUser,is_active:false},{...authUser,token_version:5},{...authUser,session_id:null},{...authUser,session_logout_time:'2026-11-02T00:00:00Z'}]){
    const reader=localReader({load:async()=>({rows:current?[current]:[]})});
    const result=await reader.invoke();
    assert.equal(result.allowed,false);
    assert.equal(result.res.statusCode,401);
    assert.equal(reader.remoteCalls,0);
  }
  const reader=localReader();
  const result=await reader.invoke({headers:{'X-Session-ID':'invalid'}});
  assert.equal(result.allowed,false);
  assert.equal(result.res.statusCode,401);
  assert.equal(reader.queries.length,0);
});

test('local mode uses current database role and organization rather than stale JWT claims',async()=>{
  const current={...authUser,role:'staff',organization_id:9};
  const reader=localReader({load:async()=>({rows:[current]})});
  const result=await reader.invoke();
  assert.equal(result.allowed,true);
  assert.equal(result.req.user.role,'staff');
  assert.equal(result.req.user.organization_id,9);
});

test('local mode preserves app-login, client realm and cross-application denials',async()=>{
  const deniedCases=[
    {current:{...authUser,can_login_accounts:false}},
    {current:{...authUser,role:'client'}},
    {token:tokenFor({...claims,realm:'client'})},
    {token:tokenFor({...claims,aud:'client'})},
    {token:tokenFor({...claims,app:'booking_accounts'})},
    {headers:{'X-App-Context':'unknown'}},
    {headers:{Origin:'https://www.dgdefence.com','X-App-Context':'booking_accounts'}},
  ];
  for(const {current=authUser,...options} of deniedCases){
    const reader=localReader({load:async()=>({rows:[current]})});
    const result=await reader.invoke(options);
    assert.equal(result.allowed,false);
    assert.equal(result.error?.statusCode,403);
    assert.equal(reader.remoteCalls,0);
  }
});

test('local mode coalesces simultaneous checks but immediately rechecks completed auth state',async()=>{
  let release;
  const gate=new Promise(resolve=>{release=resolve;});
  let current=authUser;
  const reader=localReader({load:async()=>{await gate;return {rows:[current]};}});
  const first=reader.invoke();
  const second=reader.invoke();
  assert.equal(reader.queries.length,1);
  release();
  const results=await Promise.all([first,second]);
  assert.ok(results.every(result=>result.allowed));
  assert.notEqual(results[0].req.user.permissionsByModule,results[1].req.user.permissionsByModule,'request permission state is never shared');
  current={...authUser,session_logout_time:'2026-11-02T00:00:00Z'};
  const revoked=await reader.invoke();
  assert.equal(reader.queries.length,2);
  assert.equal(revoked.allowed,false);
  assert.equal(revoked.res.statusCode,401);
});

test('local mode does not coalesce different users or sessions',async()=>{
  const reader=localReader({load:async(_sql,[id,sessionId])=>({rows:[{...authUser,id,session_id:sessionId}]})});
  const results=await Promise.all([
    reader.invoke(),
    reader.invoke({headers:{'X-Session-ID':'124'}}),
    reader.invoke({token:tokenFor({...claims,id:8})}),
  ]);
  assert.ok(results.every(result=>result.allowed));
  assert.equal(reader.queries.length,3);
});

test('local DB failures stay denied without fallback and are not cached',async()=>{
  let broken=true;
  const failure=new Error('Auth database unavailable');
  const reader=localReader({load:async()=>{if(broken)throw failure;return {rows:[authUser]};}});
  const failed=await reader.invoke();
  assert.equal(failed.allowed,false);
  assert.equal(failed.error,failure);
  assert.equal(reader.remoteCalls,0);
  broken=false;
  assert.equal((await reader.invoke()).allowed,true);
  assert.equal(reader.queries.length,2);
});

test('unknown preview auth modes fail at configuration time',()=>{
  assert.throws(()=>createWalletOpeningPreviewAuth({mode:'automatic'}),/must be local or upstream/);
});
