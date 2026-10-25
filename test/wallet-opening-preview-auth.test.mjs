import test from 'node:test';
import assert from 'node:assert/strict';
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
