import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = (await readFile(new URL('../src/controllers/signature.controller.js', import.meta.url), 'utf8'))
  .replace(/import asyncHandler[^;]+;/, 'const asyncHandler = fn => fn;')
  .replace(/import pool[^;]+;/, 'const pool = {query: (...args) => globalThis.signatureTest.query(...args)};')
  .replace(/import \{ loadReceiptImage \}[^;]+;/, 'const loadReceiptImage = (...args) => globalThis.signatureTest.load(...args);');
const { getSignatureImages } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const response = () => ({code:200,status(code){this.code=code;return this;},set(){return this;},json(value){this.body=value;return this;}});
const request = (role='sub_admin') => ({params:{target:'plot_payment',id:'22'},user:{id:8,role,organization_id:1}});

test('denies another site before reading any signature bytes', async () => {
  const calls=[];
  globalThis.signatureTest={query:async sql=>{calls.push(sql);return calls.length===1?{rows:[{site_id:9}]}:{rows:[]};},load:()=>assert.fail('must not load another site’s image')};
  const res=response();await getSignatureImages(request(),res);
  assert.equal(res.code,403);assert.equal(calls.length,2);
});

test('loads only database-owned URLs after site access and returns uncached embedded images', async () => {
  const url='https://mountreality.s3.us-east-1.amazonaws.com/vouchers/ink.png';
  const queries=[];
  globalThis.signatureTest={query:async(sql,params)=>{
    queries.push({sql,params});
    if(sql.includes('SELECT site_id'))return {rows:[{site_id:9}]};
    if(sql.includes('user_sites'))return {rows:[{ok:1}]};
    if(sql.includes('to_jsonb'))return {rows:[{customer_signature_url:url,authority_signature_url:null}]};
    return {rows:[]};
  },load:async value=>{assert.equal(value,url);return 'data:image/png;base64,aW5r';}};
  const res=response();let cache;res.set=(name,value)=>{cache=[name,value];return res;};
  const req=request();req.query={url:'https://untrusted.test/private'};
  await getSignatureImages(req,res);
  assert.equal(res.code,200);assert.equal(res.body.images[url],'data:image/png;base64,aW5r');
  assert.deepEqual(cache,['Cache-Control','no-store']);
  assert.deepEqual(queries.at(-1).params,[1,'plot_payment','22']);
});

test('unknown targets and invalid IDs never reach database or storage', async () => {
  globalThis.signatureTest={query:()=>assert.fail('unexpected database read'),load:()=>assert.fail('unexpected storage read')};
  for(const params of [{target:'users',id:'22'},{target:'plot_payment',id:'1 OR 1=1'}]) {
    const res=response();await getSignatureImages({...request(),params},res);assert.equal(res.code,400);
  }
});
