import test from 'node:test';
import assert from 'node:assert/strict';
import { warmRequestHistorySchema } from '../src/services/requestHistory.service.js';

test('schema warmup shares initial work and an expired catalog refresh never blocks a history read',async()=>{
  const originalNow=Date.now;
  let now=1000,queries=0,finish;
  const row={table_name:'expenses',column_name:'id',data_type:'integer',udt_name:'int4'};
  const db={query:()=>{queries++;return new Promise(resolve=>{finish=resolve;});}};
  Date.now=()=>now;
  try {
    const first=warmRequestHistorySchema(db),second=warmRequestHistorySchema(db);
    assert.equal(queries,1);finish({rows:[row]});
    const schema=await first;assert.equal(schema,await second);assert.ok(schema.get('expenses').has('id'));
    now+=61000;
    assert.equal(await warmRequestHistorySchema(db),schema,'existing metadata returns without waiting for refresh');
    assert.equal(await warmRequestHistorySchema(db),schema);assert.equal(queries,2,'only one refresh can run');
    finish({rows:[row,{...row,column_name:'approved_at',data_type:'timestamp with time zone',udt_name:'timestamptz'}]});
    await new Promise(resolve=>setImmediate(resolve));
    assert.ok((await warmRequestHistorySchema(db)).get('expenses').has('approved_at'),'completed refresh becomes visible');
    assert.equal(queries,2);
  } finally {Date.now=originalNow;}
});
