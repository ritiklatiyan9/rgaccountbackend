import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { getImprestHandoverSummary } from '../src/services/imprestHandoverSummary.service.js';

const admin={id:1,role:'admin',organization_id:1,is_active:true};
const staff={id:2,role:'sub_admin',organization_id:1,is_active:true};
const viewer={id:3,role:'sub_admin',organization_id:1,is_active:true};

test('confirmed Imprest totals include every owning handover once, filter by confirmation dates and preserve visibility',async t=>{
 const db=new PGlite();
 try{
  await db.exec(`CREATE TABLE sites(id int PRIMARY KEY,organization_id int);INSERT INTO sites VALUES(10,1),(11,1),(20,2);
   CREATE TABLE users(id int PRIMARY KEY,name text,role text,is_active boolean,organization_id int,photo text);
   INSERT INTO users(id,name,role,is_active,organization_id) VALUES(1,'Admin','admin',true,1),(2,'Ravi','sub_admin',true,1),(3,'Viewer','sub_admin',true,1),
    (4,'Sunny','sub_admin',true,1),(5,'Bob','sub_admin',true,1),(6,'Other site','sub_admin',true,1),(7,'Other org','admin',true,2);
   UPDATE users SET photo='https://example.test/ravi.jpg' WHERE id=2;
   UPDATE users SET photo='https://example.test/private-sunny.jpg' WHERE id=4;
   CREATE TABLE user_sites(user_id int,site_id int);INSERT INTO user_sites VALUES(2,10),(3,10),(4,10),(5,10),(6,11);
   CREATE TABLE imprest_management_visibility(viewer_id int,site_id int,visible_user_ids int[]);
   INSERT INTO imprest_management_visibility VALUES(3,10,ARRAY[2]);
   CREATE TABLE imprest_allocations(id int,site_id int,admin_id int,sub_admin_id int,amount numeric,status text,created_at timestamptz,confirmed_at timestamptz,remark text);
   INSERT INTO imprest_allocations VALUES
    (1,10,1,2,100.10,'RECEIVED','2026-11-01T01:00:00Z','2026-11-01T19:00:00Z','First'),
    (2,10,2,4,40.05,'RECEIVED','2026-11-01T02:00:00Z','2026-11-02T18:29:59.999999Z','Last second'),
    (3,10,1,2,1000,'PENDING_RECEIPT',now(),NULL,'Pending'),
    (4,10,1,2,1000,'CANCELLED',now(),NULL,'Cancelled'),
    (5,11,1,2,900,'RECEIVED','2026-11-01T00:00:00Z','2026-11-01T00:00:00Z','Other site'),
    (6,10,7,2,901,'RECEIVED','2026-11-01T00:00:00Z','2026-11-01T00:00:00Z','Other org'),
    (7,10,1,4,50,'RECEIVED','2026-11-02T01:00:00Z','2026-11-02T18:30:00Z','Next day'),
    (8,10,1,2,999,'RECEIVED','2099-11-01T01:00:00Z','2099-11-02T01:00:00Z','Future'),
    (9,10,1,2,0,'RECEIVED','2026-11-01T01:00:00Z','2026-11-02T01:00:00Z','Zero');
   CREATE TABLE imprest_transfers(id int,site_id int,from_user_id int,to_user_id int,amount numeric,created_at timestamptz,remark text);
   INSERT INTO imprest_transfers VALUES(1,10,2,4,10.20,'2026-11-02T10:00:00Z','Immediate'),(2,10,4,2,5.10,'2026-11-02T11:00:00Z','Return handover');
   CREATE TABLE wallet_imprest_transfers(id text,site_id int,organization_id int,from_user_id int,to_user_id int,amount numeric,status text,
    resolved_at timestamptz,sender_accepted_at timestamptz,recipient_accepted_at timestamptz,created_at timestamptz,note text);
   INSERT INTO wallet_imprest_transfers VALUES
    ('accepted',10,1,1,2,20.15,'accepted','2026-11-02T12:00:00Z',NULL,NULL,'2026-11-01T10:00:00Z','Wallet'),
    ('partial',10,1,1,2,999,'pending',NULL,'2026-11-02T12:00:00Z',NULL,'2026-11-01T10:00:00Z','Only one accepted'),
    ('other',10,2,7,2,999,'accepted','2026-11-02T12:00:00Z',NULL,NULL,'2026-11-01T10:00:00Z','Other org');`);
  const read=(actor=admin,query={},rights={canReadPersonal:true,canManage:true})=>getImprestHandoverSummary(db,{actor,query:{site_id:10,...query},...rights});
  await t.test('all-time and person totals use all three sources without double counting or page-only sums',async()=>{
   const all=await read(admin,{scope:'management',person_id:'all',limit:1});
   assert.deepEqual(all.totals,{given:'225.60',received:'225.60',given_count:6,received_count:6});
   assert.equal(all.pagination.total,6);assert.equal(all.entries.length,1);assert.equal(all.pagination.pages,6);
   const totalsFor=(result,id)=>{const person=result.people.find(row=>row.id===id);return [person.total_given,person.total_received,person.given_count,person.received_count];};
   assert.deepEqual(totalsFor(all,2),['50.25','125.35',2,3],'person columns sum all sources across every page');
   assert.deepEqual(totalsFor(all,5),['0','0',0,0],'eligible people with no handovers show zero');
   const ravi=await read(staff);assert.deepEqual(ravi.totals,{given:'50.25',received:'125.35',given_count:2,received_count:3});
   assert.equal(ravi.entries.length,5);assert.equal(new Set(ravi.entries.map(r=>r.id)).size,5);
   assert.ok(!JSON.stringify(ravi).match(/Other org|Other site|Pending|Cancelled|Only one accepted|Future/));
   assert.deepEqual(ravi.people.map(p=>p.id),[2]);
   assert.equal(ravi.people[0].photo,'https://example.test/ravi.jpg');
   assert.ok(!JSON.stringify(ravi.people).includes('private-sunny.jpg'));
   const given=await read(staff,{direction:'given',limit:1,page:2});
   assert.equal(given.pagination.total,2);assert.equal(given.entries.length,1);assert.deepEqual(given.totals,ravi.totals);
   assert.ok(given.entries.every(e=>e.from_user_id===2));
   assert.deepEqual(totalsFor(given,2),['50.25','125.35',2,3],'direction and page do not narrow person columns');
   const selected=await read(admin,{person_id:4});
   assert.deepEqual(totalsFor(selected,2),['50.25','125.35',2,3],'selecting one summary person preserves every row’s own totals');
   const incoming=await read(staff,{direction:'received'});assert.equal(incoming.pagination.total,3);
   assert.ok(incoming.entries.every(e=>e.to_user_id===2));
  });
  await t.test('day filters use inclusive India confirmation dates and exclude future confirmations',async()=>{
   const day=await read(admin,{scope:'management',person_id:'all',from:'2026-11-02',to:'2026-11-02'});
   assert.equal(day.totals.given,'175.60');assert.equal(day.entries.length,5);
   assert.ok(day.entries.some(e=>e.id==='allocation:1'),'request created the previous day is counted on confirmation');
   assert.ok(day.entries.some(e=>e.id==='allocation:2'),'last microsecond of the day is included');
   assert.ok(!day.entries.some(e=>e.id==='allocation:7'),'next business day is excluded');
   assert.equal(day.people.find(p=>p.id===1).total_given,'120.25');
   assert.equal(day.people.find(p=>p.id===4).total_received,'50.25','person columns use the same confirmation-date filter');
   assert.equal((await read(admin,{to:'2099-12-31',person_id:2})).totals.received,'125.35');
   assert.equal((await read(admin,{from:'2026-11-03',to:'2026-11-03',person_id:2})).totals.received,'0');
   for(const query of [{from:'2026-02-30'},{from:'2026-11-03',to:'2026-11-02'},{direction:'invalid'},{page:0},{person_id:'2;DROP TABLE users'}])await assert.rejects(read(admin,query),e=>e.statusCode===400);
  });
  await t.test('personal and delegated management access cannot widen via filters',async()=>{
   await assert.rejects(read(staff,{person_id:4}),e=>e.statusCode===403);
   await assert.rejects(read(staff,{person_id:'all'}),e=>e.statusCode===403);
   await assert.rejects(read(viewer,{scope:'management'},{canReadPersonal:true,canManage:false}),e=>e.statusCode===403);
   const delegated=await read(viewer,{scope:'management',person_id:'all'},{canReadPersonal:false,canManage:true});
   assert.deepEqual(delegated.totals,{given:'50.25',received:'125.35',given_count:2,received_count:3});
   assert.deepEqual(delegated.people.map(p=>p.id),[2]);
   assert.equal(delegated.people[0].total_received,'125.35');
   assert.ok(!delegated.entries.some(e=>e.id==='allocation:7'));
   await assert.rejects(read(viewer,{scope:'management',person_id:4}),e=>e.statusCode===403);
   await assert.rejects(read(viewer,{scope:'personal'},{canReadPersonal:false,canManage:true}),e=>e.statusCode===403);
   await assert.rejects(read(admin,{site_id:20}),e=>e.statusCode===403);
   await db.exec('UPDATE imprest_management_visibility SET visible_user_ids=ARRAY[]::int[]');
   const revoked=await read(viewer,{scope:'management',person_id:'all'});assert.equal(revoked.totals.given,'0');assert.equal(revoked.totals.received,'0');assert.deepEqual(revoked.entries,[]);
  });
  await t.test('large aggregate totals preserve every paisa',async()=>{
   await db.exec("INSERT INTO imprest_transfers VALUES(3,10,2,4,90071992547409.91,'2026-11-02T13:00:00Z','Large exact amount')");
   const exact=await read(staff);assert.equal(exact.totals.given,'90071992547460.16');
  });
 }finally{await db.close();}
});
