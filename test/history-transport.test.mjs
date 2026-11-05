import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {gunzipSync} from 'node:zlib';
import {historyTransport,historyReadLimit,historyErrors} from '../src/middlewares/historyTransport.middleware.js';

const response=()=>Object.assign(new EventEmitter(),{headers:{},statusCode:200,
  set(key,value){this.headers[key.toLowerCase()]=value;return this;},vary(value){this.headers.vary=value;},
  status(value){this.statusCode=value;return this;},json(value){this.body=value;return this;},end(value){this.bytes=value;this.emit('finish');}});
test('history compression negotiates gzip, keeps private no-store, and round trips the response',async()=>{
  const body={entries:[{note:'Fixture '.repeat(1000)}],total:1},res=response();
  historyTransport({headers:{'accept-encoding':'gzip'},acceptsEncodings:()=>true},res,()=>{});
  const finished=new Promise(resolve=>res.once('finish',resolve));res.json(body);await finished;
  assert.equal(res.headers['cache-control'],'private, no-store');assert.equal(res.headers['content-encoding'],'gzip');
  assert.ok(res.bytes.length<Buffer.byteLength(JSON.stringify(body))/10);assert.deepEqual(JSON.parse(gunzipSync(res.bytes)),body);
  const plain=response();historyTransport({headers:{},acceptsEncodings:()=>false},plain,()=>{});plain.json(body);assert.deepEqual(plain.body,body);
});
test('per-user concurrency limits release on disconnect and history errors stay actionable',async()=>{
  const req={user:{id:987654321,organization_id:1}},accepted=[];
  for(let i=0;i<8;i++){const res=response();await historyReadLimit(req,res,()=>accepted.push(res));}
  const denied=response();await historyReadLimit(req,denied,()=>assert.fail('ninth concurrent request must be bounded'));
  assert.equal(denied.statusCode,429);assert.equal(denied.headers['retry-after'],'1');
  accepted[0].emit('close');const next=response();let admitted=false;await historyReadLimit(req,next,()=>{admitted=true;});assert.equal(admitted,true);
  for(const res of [...accepted,next])res.emit('finish');
  const timeout=response();historyErrors(Object.assign(new Error('Narrow the filters'),{code:'HISTORY_QUERY_TIMEOUT',statusCode:503}),{},timeout,()=>assert.fail());
  assert.equal(timeout.statusCode,503);assert.equal(timeout.body.message,'Narrow the filters');assert.equal(timeout.headers['retry-after'],'2');
});
