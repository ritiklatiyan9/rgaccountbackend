import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createVaultTransfer, resolveVaultTransfer } from '../src/services/loyaltyVault.service.js';

const request=()=>({site_id:10,to_holder_id:2,amount:'10.15',idempotency_key:randomUUID()});
for(const operation of ['request','decision']) {
  const run=database=>operation==='request'
    ?createVaultTransfer({id:1},request(),database)
    :resolveVaultTransfer({id:2},randomUUID(),'accept',{site_id:10},database);
  test(`normal wallet ${operation} contains an active socket error and discards its client`,async()=>{
    const client=new EventEmitter(),failure=new Error('Socket disconnected');
    const statements=[];let released;
    client.query=async sql=>{
      statements.push(sql);
      if(sql.startsWith('SELECT id, name, role')) {client.emit('error',failure);throw failure;}
      return {rows:[]};
    };
    client.release=error=>{released=error;};
    await assert.rejects(run({connect:async()=>client}),error=>error===failure);
    assert.equal(released,failure);assert.ok(statements.includes('ROLLBACK'));
    assert.equal(client.listenerCount('error'),0);
    assert.ok(statements.some(sql=>sql.includes("lock_timeout='5s'")&&sql.includes("statement_timeout='20s'")));
  });
  test(`normal wallet ${operation} preserves its original failure when rollback fails`,async()=>{
    const client=new EventEmitter(),failure=new Error('Original financial failure'),cleanup=new Error('Rollback connection failed');
    let released;
    client.query=async sql=>{
      if(sql.startsWith('SELECT id, name, role')) throw failure;
      if(sql==='ROLLBACK') throw cleanup;
      return {rows:[]};
    };
    client.release=error=>{released=error;};
    await assert.rejects(run({connect:async()=>client}),error=>error===failure);
    assert.equal(released,cleanup);assert.equal(client.listenerCount('error'),0);
  });
  test(`normal wallet ${operation} reuses a healthy connection after a rejected request`,async()=>{
    const client=new EventEmitter();let released='not released';
    client.query=async()=>({rows:[]});
    client.release=error=>{released=error;};
    await assert.rejects(run({connect:async()=>client}),error=>error.statusCode===403);
    assert.equal(released,undefined);assert.equal(client.listenerCount('error'),0);
  });
}
