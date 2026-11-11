import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import pool from '../src/config/db.js';
import { getCommissionReceivers, getCommissionAllocations } from '../src/controllers/plotCommissionV2.controller.js';
import { commissionAllocationReadCache } from '../src/routes/plotCommissionV2.routes.js';
const invoke=(handler,query,user={id:1,role:'admin',organization_id:1})=>new Promise((resolve,reject)=>handler({query,user},{json:resolve,status(code){return {json:body=>reject(Object.assign(new Error(body.message),{statusCode:code}))};}},reject));
test('receiver directory browses every organization member type and searches names and formatted phone numbers',async t=>{
  const db=new PGlite(), original=pool.query;
  pool.query=(sql,values)=>db.query(sql,values);
  t.after(async()=>{pool.query=original;await db.close();await pool.end();});
  await db.exec(`CREATE TABLE sites(id int PRIMARY KEY,organization_id int);
    CREATE TABLE user_sites(user_id int,site_id int);
    CREATE TABLE members(id int PRIMARY KEY,site_id int,full_name text,phone text,member_type text,member_types text[],aadhar_no text,status text,is_active boolean DEFAULT true);
    INSERT INTO sites VALUES(1,1),(2,1),(3,2);
    INSERT INTO members(id,site_id,full_name,phone,member_type,aadhar_no,status) VALUES
      (1,1,'Alice Dealer','+91 98765-43210','BROKER','2345 6789 0123','ACTIVE'),
      (2,1,'Bob Client','9876500002','CLIENT',NULL,'ACTIVE'),
      (3,2,'Dealer 100%','9876500003','BROKER','345678901234','ACTIVE'),
      (4,3,'Other Organization','9876500004','BROKER','345678901234','ACTIVE'),
      (5,1,'Inactive broker','9876500005','BROKER','345678901234','DISABLED'),
      (6,1,'Invalid identity broker','1234567890','BROKER','123456789012','ACTIVE');`);
  const first=await invoke(getCommissionReceivers,{site_id:'1',limit:'2'});
  assert.deepEqual(first.members.map(row=>row.id),[1,2]);
  assert.equal(first.members[0].partner_app_eligible,true);
  assert.equal(first.members[1].partner_app_eligible,false);
  assert.equal(first.has_more,true);
  const next=await invoke(getCommissionReceivers,{site_id:'1',cursor:first.next_cursor});
  assert.deepEqual(next.members.map(row=>row.id),[3,5,6]);
  assert.deepEqual(next.members.map(row=>row.partner_app_eligible),[true,false,false]);
  assert.deepEqual((await invoke(getCommissionReceivers,{site_id:'1',q:'98765-43210'})).members.map(row=>row.id),[1]);
  for(const q of ['+91 98765 00002','0091 98765 00002','09876500002']) {
    assert.deepEqual((await invoke(getCommissionReceivers,{site_id:'1',q})).members.map(row=>row.id),[2]);
  }
  assert.deepEqual((await invoke(getCommissionReceivers,{site_id:'1',q:'+91 98765 43210'})).members.map(row=>row.id),[1]);
  assert.deepEqual((await invoke(getCommissionReceivers,{site_id:'1',q:'ALICE'})).members.map(row=>row.id),[1]);
  assert.deepEqual((await invoke(getCommissionReceivers,{site_id:'1',q:'100%'})).members.map(row=>row.id),[3]);
  assert.equal(first.members.some(row=>'aadhar_no' in row),false);
  await assert.rejects(invoke(getCommissionReceivers,{site_id:'3'}),/Site not found/);
  await assert.rejects(invoke(getCommissionReceivers,{site_id:'1'},{id:9,role:'sub_admin',organization_id:1}),/Site not found/);
  await db.exec(`CREATE TABLE plots(id int PRIMARY KEY,site_id int,plot_no text,buyer_name text,plot_size numeric,plot_rate numeric,plot_commission numeric,unit_type text);
    CREATE TABLE plot_commissions_v2(id int PRIMARY KEY,site_id int,plot_id int,agent_id int,total_commission numeric,remarks text,allocation_type text,allocation_value numeric,allocation_base numeric);
    CREATE TABLE plot_commission_payments(id int PRIMARY KEY,plot_commission_id int,created_by int);
    INSERT INTO plots VALUES(10,1,'A2','Buyer',100,200,1000,'shop');
    INSERT INTO plot_commissions_v2 VALUES(100,1,10,1,300,'Remark','percentage',30,1000),(101,1,10,3,700,NULL,'amount',700,1000);
    INSERT INTO plot_commission_payments VALUES(1,100,99);`);
  const detail=await invoke(getCommissionAllocations,{site_id:'1',plot_id:'10'});
  assert.equal(detail.plot.unit_type,'shop');
  assert.equal(detail.agents[0].payment_history_count,1);
  assert.equal(detail.agents[0].allocation_value,30);
  assert.equal(detail.agents[1].agent_id,3);
  assert.ok(!JSON.stringify(detail).includes('created_by'));
  await db.query('INSERT INTO user_sites VALUES(9,1)');
  const req={method:'GET',headers:{},path:'/allocations',query:{site_id:'1',plot_id:'10'},user:{id:9,role:'sub_admin',organization_id:1}};
  const oldCache=process.env.CACHE_ENABLED;process.env.CACHE_ENABLED='true';
  t.after(()=>{if(oldCache===undefined)delete process.env.CACHE_ENABLED;else process.env.CACHE_ENABLED=oldCache;});
  const cacheHeaders=[];
  const cachedRead=()=>new Promise((resolve,reject)=>{
    const res={statusCode:200,setHeader(key,value){if(key==='X-Cache')cacheHeaders.push(value);},status(code){this.statusCode=code;return this;},json:resolve};
    commissionAllocationReadCache(req,res,error=>error?reject(error):getCommissionAllocations(req,res,reject));
  });
  assert.equal((await cachedRead()).agents.length,2);
  assert.equal((await cachedRead()).agents.length,2);
  assert.equal(cacheHeaders.at(-1),'HIT');
  await db.query('DELETE FROM user_sites WHERE user_id=9');
  await assert.rejects(cachedRead(),/Site not found/);

});
