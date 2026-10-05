import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import pool from '../src/config/db.js';
import { memberModel } from '../src/models/Member.model.js';
import { MEMBER_FIELDS,DOC_FIELDS } from '../src/services/memberProfileFields.js';
import { lockMemberDirectory,registerMemberAcrossSites,syncSharedMemberProfile } from '../src/services/memberSiteSharing.service.js';
import { up } from '../src/migrations/187_member_site_sharing.js';
import { up as linkMigration } from '../src/migrations/192_member_identity_linking.js';
import { up as consolidationMigration } from '../src/migrations/194_member_identity_consolidation.js';
import { reviewMemberIdentity } from '../src/services/memberIdentityLink.service.js';
import { createMember,updateMember } from '../src/controllers/member.controller.js';
import { createCase,verifyCase } from '../src/controllers/memberKyc.controller.js';

// All operations use an isolated PostgreSQL engine. The configured application
// pool is replaced before invoking controllers; no live database is contacted.
const user={id:7,role:'admin',organization_id:1};
async function fixture(t,{migrate=true}={}) {
  const sql=new PGlite();t.after(()=>sql.close());
  const fields=[...new Set([...MEMBER_FIELDS,...DOC_FIELDS,'geocode_source','geocode_precision','geocoded_at'])];
  const fieldSql=fields.map(field=>`${field} ${['latitude','longitude'].includes(field) ? 'NUMERIC' : field==='geocoded_at' ? 'TIMESTAMPTZ' : 'TEXT'}`).join(',');
  await sql.exec(`CREATE TABLE sites(id INTEGER PRIMARY KEY,name TEXT,organization_id INTEGER NOT NULL);
    INSERT INTO sites VALUES(1,'SOURCE',1),(2,'SECOND',1),(3,'THIRD',1),(4,'OTHER ORGANISATION',2);
    CREATE TABLE user_sites(user_id INTEGER,site_id INTEGER);
    INSERT INTO user_sites VALUES(8,1);
    CREATE TABLE app_schema_migrations(version TEXT PRIMARY KEY);
    CREATE TABLE members(id SERIAL PRIMARY KEY,site_id INTEGER REFERENCES sites(id),created_by INTEGER,
      created_at TIMESTAMPTZ DEFAULT now(),updated_at TIMESTAMPTZ DEFAULT now(),member_types TEXT[],${fieldSql});
    CREATE TABLE kyc_cases(id SERIAL PRIMARY KEY,booking_id INTEGER,client_member_id INTEGER REFERENCES members(id),
      site_id INTEGER REFERENCES sites(id),mode TEXT,status TEXT,created_by INTEGER,verified_by INTEGER,
      verified_at TIMESTAMPTZ,reused_from_case_id INTEGER REFERENCES kyc_cases(id),created_at TIMESTAMPTZ,updated_at TIMESTAMPTZ);
    CREATE TABLE documents(id SERIAL PRIMARY KEY,kyc_case_id INTEGER REFERENCES kyc_cases(id),client_member_id INTEGER REFERENCES members(id),
      site_id INTEGER,type TEXT,member_document_field TEXT,original_name TEXT,file_path TEXT,file_hash TEXT,mime_type TEXT,
      file_size BIGINT,ocr_status TEXT,ocr_engine TEXT,ocr_completed_at TIMESTAMPTZ,ocr_error TEXT,uploaded_source TEXT,
      uploaded_by INTEGER,created_at TIMESTAMPTZ,updated_at TIMESTAMPTZ);
    CREATE TABLE ocr_results(id SERIAL PRIMARY KEY,document_id INTEGER REFERENCES documents(id),raw_text TEXT,
      extracted_fields JSONB,confidence_overall NUMERIC,confidence_map JSONB,engine TEXT,processed_at TIMESTAMPTZ);
    CREATE TABLE plots(id INTEGER PRIMARY KEY,site_id INTEGER,buyer_member_id INTEGER REFERENCES members(id),updated_at TIMESTAMPTZ);
    INSERT INTO plots(id,site_id) VALUES(101,1),(102,2);
    CREATE TABLE bookings(id INTEGER PRIMARY KEY,kyc_status TEXT,status TEXT,updated_at TIMESTAMPTZ);
    CREATE TABLE financial_entries(id INTEGER PRIMARY KEY,site_id INTEGER,amount NUMERIC);
    INSERT INTO financial_entries VALUES(1,1,12345.67),(2,2,987.65);`);
  const query=async(text,values)=>{const result=await sql.query(text,values);return {...result,rowCount:result.affectedRows};};
  const db={query,release(){}};const fixturePool={query,connect:async()=>db};
  if(migrate) {await up(fixturePool);await up(fixturePool);await linkMigration(fixturePool);await consolidationMigration(fixturePool);} // additive and restart-safe
  const oldQuery=pool.query,oldConnect=pool.connect;
  pool.query=query;pool.connect=async()=>db;
  t.after(()=>{pool.query=oldQuery;pool.connect=oldConnect;});
  return {sql,db,query,fixturePool};
}
function invoke(handler,body={},params={},actor=user) {
  return new Promise((resolve,reject)=>{
    const res={statusCode:200,status(code){this.statusCode=code;return this;},json(data){resolve({status:this.statusCode,data});}};
    handler({body,params,user:actor,clientKycPermissions:{canUpdate:true}},res,reject);
  });
}
async function transaction(db,fn,actor=user) {
  await db.query('BEGIN');
  try {await lockMemberDirectory(db,actor);const result=await fn();await db.query('COMMIT');return result;}
  catch(error){await db.query('ROLLBACK');throw error;}
}
const data=(changes={})=>({site_id:1,full_name:'TEST CLIENT',phone:'9876543210',member_type:'CLIENT',member_types:['CLIENT','FARMER'],status:'ACTIVE',created_by:7,...changes});
async function verifiedCase(db,member,changes={}) {
  const {rows:[saved]}=await db.query(`INSERT INTO kyc_cases(client_member_id,site_id,mode,status,created_by,verified_by,verified_at,created_at,updated_at)
    VALUES($1,$2,'MANUAL_OCR',$3,7,7,now(),now(),now()) RETURNING *`,[member.id,member.site_id,changes.status || 'VERIFIED']);
  for(const field of ['aadhar_front_url','aadhar_back_url']) {
    const {rows:[document]}=await db.query(`INSERT INTO documents(kyc_case_id,client_member_id,site_id,type,member_document_field,
      original_name,file_path,ocr_status,file_hash) VALUES($1,$2,$3,'AADHAAR',$4,$4,$5,'DONE',$4) RETURNING id`,
      [saved.id,member.id,member.site_id,field,`kyc/${member.id}/${field}.jpg`]);
    await db.query(`INSERT INTO ocr_results(document_id,raw_text,extracted_fields,confidence_overall,confidence_map,engine,processed_at)
      VALUES($1,'Original OCR text','{"name":"TEST CLIENT"}',0.95,'{}','fixture',now())`,[document.id]);
  }
  return saved;
}

test('startup migration repairs the missing sharing column before client registration and preserves existing profiles',async t=>{
  const {query,fixturePool}=await fixture(t,{migrate:false});
  await query("INSERT INTO members(site_id,full_name,phone,member_type) VALUES(4,'Existing profile','9000000000','CLIENT')");
  const before=(await query('SELECT * FROM members')).rows[0];
  await assert.rejects(query('SELECT shared_profile_id FROM members LIMIT 1'),{code:'42703'});
  await up(fixturePool);
  await up(fixturePool);
  const {shared_profile_id,...after}=(await query('SELECT * FROM members WHERE id=$1',[before.id])).rows[0];
  assert.equal(shared_profile_id,null);assert.deepEqual(after,before);
  const result=await invoke(createMember,{site_id:1,full_name:'New client',phone:'9876543210'});
  assert.equal(result.status,201);assert.equal(result.data.registration.site_count,3);
  assert.deepEqual((await query('SELECT site_id FROM members WHERE shared_profile_id=$1 ORDER BY site_id',[result.data.registration.shared_profile_id])).rows.map(row=>row.site_id),[1,2,3]);
  assert.equal((await query("SELECT count(*)::int AS n FROM app_schema_migrations WHERE version='187_member_site_sharing'")).rows[0].n,1);
});

test('adding from Clients automatically registers all organisation sites, preserves roles and links only the selected plot',async t=>{
  const {query}=await fixture(t);
  const result=await invoke(createMember,{site_id:1,full_name:'Test Client',phone:'+91 98765 43210',member_types:'CLIENT,FARMER',plot_id:101});
  assert.equal(result.status,201);assert.equal(result.data.registration.site_count,3);
  const {rows}=await query('SELECT * FROM members ORDER BY site_id');
  assert.deepEqual(rows.map(row=>row.site_id),[1,2,3]);assert.equal(new Set(rows.map(row=>row.shared_profile_id)).size,1);
  for(const row of rows) {assert.equal(row.phone,'9876543210');assert.deepEqual(row.member_types,['CLIENT','FARMER']);}
  assert.equal((await query('SELECT buyer_member_id FROM plots WHERE id=101')).rows[0].buyer_member_id,result.data.member.id);
  assert.equal((await query('SELECT buyer_member_id FROM plots WHERE id=102')).rows[0].buyer_member_id,null);
  assert.deepEqual((await query('SELECT amount::text FROM financial_entries ORDER BY id')).rows.map(row=>row.amount),['12345.67','987.65']);
  assert.equal((await query('SELECT count(*)::int AS n FROM kyc_cases')).rows[0].n,0);
  assert.equal((await invoke(createMember,{site_id:2,full_name:'Test Client',phone:'9876543210'})).status,409);
});

test('an authorised add from one assigned site shares globally within the organisation but cannot originate in an inaccessible site',async t=>{
  const {query}=await fixture(t);const actor={id:8,role:'sub_admin',organization_id:1,permissionsByModule:new Map()};
  const result=await invoke(createMember,{site_id:1,full_name:'Test Client',phone:'9876543210'},{},actor);
  assert.equal(result.status,201);assert.equal(result.data.registration.site_count,3);
  const denied=await invoke(createMember,{site_id:2,full_name:'Another Client',phone:'9000000000'},{},actor);
  assert.equal(denied.status,403);assert.equal((await query('SELECT count(*)::int AS n FROM members')).rows[0].n,3);
});

test('verified profile and original document references/OCR are copied once and retrying registration is idempotent',async t=>{
  const {db,query}=await fixture(t);
  const source=await memberModel.create(data({aadhar_no:'123456789012',photo:'https://files.example/photo.jpg',address:'Verified address'}),db);
  await verifiedCase(db,source);
  await transaction(db,()=>registerMemberAcrossSites(db,{memberId:source.id,user}));
  await transaction(db,()=>registerMemberAcrossSites(db,{memberId:source.id,user}));
  assert.equal((await query('SELECT count(*)::int AS n FROM members')).rows[0].n,3);
  assert.equal((await query('SELECT count(*)::int AS n FROM kyc_cases')).rows[0].n,3);
  assert.equal((await query('SELECT count(*)::int AS n FROM documents')).rows[0].n,6);
  assert.equal((await query('SELECT count(*)::int AS n FROM ocr_results')).rows[0].n,6);
  assert.equal((await query('SELECT count(DISTINCT file_path)::int AS n FROM documents')).rows[0].n,2);
  assert.ok((await query('SELECT * FROM members')).rows.every(row=>row.photo===source.photo && row.address===source.address));
});

test('Add User reuses an existing verified registration and copies its documents without duplicating the lineage',async t=>{
  const {db,query}=await fixture(t);
  const verified=await memberModel.create(data({site_id:2,aadhar_no:'123456789012',address:'Verified address'}),db);
  await verifiedCase(db,verified);
  const added=await invoke(createMember,{site_id:1,full_name:'Test Client',phone:'9876543210'});
  assert.equal(added.status,201);assert.equal(added.data.kyc_reused,true);
  assert.equal((await query('SELECT count(*)::int AS n FROM members')).rows[0].n,3);
  assert.equal((await query('SELECT count(*)::int AS n FROM documents')).rows[0].n,6);
  assert.ok((await query('SELECT * FROM members')).rows.every(row=>row.address==='Verified address' && row.aadhar_no==='123456789012'));
  assert.ok((await query('SELECT * FROM kyc_cases')).rows.every(row=>row.status==='VERIFIED'));
});

test('matching existing registration is linked without a duplicate or changes to its site roles and notes',async t=>{
  const {db,query}=await fixture(t);
  const existing=await memberModel.create(data({site_id:2,phone:'+91 9876543210',member_type:'BROKER',member_types:['BROKER'],notes:'Site-specific',address:'Existing address'}),db);
  const result=await invoke(createMember,{site_id:1,full_name:'Test Client',phone:'9876543210'});
  assert.equal(result.status,201);assert.equal(result.data.registration.existing_count,1);
  const {rows:[after]}=await query('SELECT * FROM members WHERE id=$1',[existing.id]);
  assert.equal(after.shared_profile_id,result.data.member.shared_profile_id);
  assert.equal(after.notes,'Site-specific');assert.equal(after.address,'Existing address');assert.deepEqual(after.member_types,['BROKER']);
  assert.equal((await query('SELECT count(*)::int AS n FROM members')).rows[0].n,3);
});

test('conflicting or ambiguous matches roll back the original add and all other registrations',async t=>{
  const {db,query}=await fixture(t);
  await memberModel.create(data({site_id:2,full_name:'DIFFERENT PERSON'}),db);
  await assert.rejects(invoke(createMember,{site_id:1,full_name:'Test Client',phone:'9876543210'}),{statusCode:409});
  assert.deepEqual((await query('SELECT site_id,shared_profile_id FROM members')).rows,[{site_id:2,shared_profile_id:null}]);
  await query("UPDATE members SET full_name='TEST CLIENT'");
  await memberModel.create(data({site_id:2}),db);
  await assert.rejects(invoke(createMember,{site_id:1,full_name:'Test Client',phone:'9876543210'}),/More than one/);
  assert.equal((await query('SELECT count(*)::int AS n FROM members')).rows[0].n,2);
});

test('direct KYC entry creates all registrations and later verification shares reviewed details and documents',async t=>{
  const {db,query}=await fixture(t);
  const response=await invoke(createCase,{site_id:1,full_name:'Test Client',phone:'9876543210'});
  assert.equal(response.status,201);assert.equal((await query('SELECT count(*)::int AS n FROM members')).rows[0].n,3);
  const source=(await query('SELECT * FROM members WHERE id=$1',[response.data.client_member_id])).rows[0];
  const ready=await verifiedCase(db,source,{status:'OCR_DONE'});
  const result=await invoke(verifyCase,{member_update:{full_name:'TEST CLIENT CORRECTED',phone:'9000000001',aadhar_no:'123456789012',address:'VERIFIED ADDRESS'}},{id:ready.id});
  assert.equal(result.status,200);
  const members=(await query('SELECT * FROM members')).rows;
  assert.ok(members.every(row=>row.phone==='9000000001' && row.full_name==='TEST CLIENT CORRECTED' && row.aadhar_no==='123456789012' && row.address==='VERIFIED ADDRESS'));
  const cases=(await query("SELECT * FROM kyc_cases WHERE status='VERIFIED' ORDER BY site_id")).rows;
  assert.equal(cases.length,3);assert.ok(cases.slice(1).every(row=>row.reused_from_case_id===ready.id));
  assert.equal((await query('SELECT count(*)::int AS n FROM documents')).rows[0].n,6);
  assert.equal((await query('SELECT count(*)::int AS n FROM ocr_results')).rows[0].n,6);
});

test('subsequent identity and document edits follow the explicit profile link; site categories stay local',async t=>{
  const {query}=await fixture(t);
  const added=await invoke(createMember,{site_id:1,full_name:'Test Client',phone:'9876543210'});
  const updated=await invoke(updateMember,{full_name:'CORRECTED CLIENT',phone:'9000000001',address:'New address',member_type:'VENDOR'}, {id:added.data.member.id});
  assert.equal(updated.status,200);assert.equal(updated.data.sharing.updated_count,2);
  const rows=(await query('SELECT * FROM members ORDER BY site_id')).rows;
  assert.ok(rows.every(row=>row.full_name==='CORRECTED CLIENT' && row.phone==='9000000001' && row.address==='New address'));
  assert.deepEqual(rows.map(row=>row.member_type),['VENDOR','CLIENT','CLIENT']);
  await query("UPDATE members SET photo='https://files.example/old.jpg'");
  await invoke(updateMember,{remove_photo:'true'},{id:rows[1].id});
  assert.ok((await query('SELECT photo FROM members')).rows.every(row=>row.photo===null));
});

test('a new verification from another linked site refreshes KYC, keeps prior history and completes pending reviews',async t=>{
  const {db,query}=await fixture(t);
  const source=await memberModel.create(data(),db);await verifiedCase(db,source);
  await transaction(db,()=>registerMemberAcrossSites(db,{memberId:source.id,user}));
  const second=(await query('SELECT * FROM members WHERE site_id=2')).rows[0];
  const nextCase=await verifiedCase(db,second,{status:'OCR_DONE'});
  const pending=await invoke(createCase,{site_id:1,client_member_id:source.id});
  await invoke(verifyCase,{member_update:{address:'NEW VERIFIED ADDRESS'}},{id:nextCase.id});
  const {rows:latest}=await query(`SELECT DISTINCT ON (site_id) * FROM kyc_cases WHERE status='VERIFIED'
    ORDER BY site_id,verified_at DESC,id DESC`);
  assert.equal(latest.length,3);
  assert.equal(latest[0].id,pending.data.id);assert.equal(latest[0].reused_from_case_id,nextCase.id);
  assert.equal(latest[1].id,nextCase.id);assert.equal(latest[2].reused_from_case_id,nextCase.id);
  assert.equal((await query("SELECT count(*)::int AS n FROM kyc_cases WHERE status='VERIFIED'")).rows[0].n,6);
  assert.ok((await query('SELECT address FROM members')).rows.every(row=>row.address==='NEW VERIFIED ADDRESS'));
  assert.equal((await query('SELECT count(*)::int AS n FROM documents')).rows[0].n,12);
  await transaction(db,()=>syncSharedMemberProfile(db,{memberId:second.id,user,verified:true}));
  assert.equal((await query('SELECT count(*)::int AS n FROM documents')).rows[0].n,12);
});

test('a cross-site phone conflict rolls back all profile edits, and unlinked legacy clients stay local',async t=>{
  const {db,query}=await fixture(t);
  const added=await invoke(createMember,{site_id:1,full_name:'Test Client',phone:'9876543210'});
  await memberModel.create(data({site_id:2,full_name:'OTHER CLIENT',phone:'9000000001'}),db);
  await assert.rejects(invoke(updateMember,{phone:'9000000001'},{id:added.data.member.id}),{statusCode:409});
  assert.equal((await query('SELECT phone FROM members WHERE id=$1',[added.data.member.id])).rows[0].phone,'9876543210');
  const legacy=await memberModel.create(data({site_id:3,phone:'9000000002'}),db);
  const result=await transaction(db,()=>syncSharedMemberProfile(db,{memberId:legacy.id,user,changedFields:['phone']}));
  assert.equal(result.updated_count,0);
});

test('failures while copying KYC documents roll back registrations, links and verification together',async t=>{
  const {db,query}=await fixture(t);
  const source=await memberModel.create(data(),db);await verifiedCase(db,source);
  await query("ALTER TABLE documents ADD CONSTRAINT reject_target_documents CHECK(site_id<>3)");
  await assert.rejects(transaction(db,()=>registerMemberAcrossSites(db,{memberId:source.id,user})),/reject_target_documents/);
  assert.equal((await query('SELECT count(*)::int AS n FROM members')).rows[0].n,1);
  assert.equal((await query('SELECT shared_profile_id FROM members')).rows[0].shared_profile_id,null);
  assert.equal((await query('SELECT count(*)::int AS n FROM kyc_cases')).rows[0].n,1);
  assert.equal((await query('SELECT count(*)::int AS n FROM documents')).rows[0].n,2);
});

test('members without phone/identity still share safely by explicit group, not by a common name',async t=>{
  const {db,query}=await fixture(t);
  await memberModel.create(data({site_id:2,phone:null}),db);
  const added=await invoke(createMember,{site_id:1,full_name:'Test Client'});
  assert.equal(added.status,201);assert.equal((await query('SELECT count(*)::int AS n FROM members')).rows[0].n,4);
  assert.equal((await query('SELECT count(*)::int AS n FROM members WHERE shared_profile_id IS NOT NULL')).rows[0].n,3);
});

test('verified KYC is authoritative for linked copies even when unrelated clients reuse its identity numbers',async t=>{
  const {db,query}=await fixture(t);
  const unrelated=await memberModel.create(data({site_id:2,full_name:'OTHER CLIENT',phone:'9000000001',aadhar_no:'123456789123',pan_no:'ABCDE1234F'}),db);
  const otherOrg=await memberModel.create(data({site_id:4,full_name:'Test Client',phone:'9876543210',aadhar_no:'123456789123'}),db);
  const source=(await invoke(createMember,{site_id:1,full_name:'Test Client',phone:'9876543210'})).data.member;
  const kyc=await verifiedCase(db,source,{status:'OPEN'});
  const result=await invoke(verifyCase,{member_update:{full_name:'VERIFIED CLIENT',phone:'9876543210',aadhar_no:'123456789123',pan_no:'ABCDE1234F',address:'REVIEWED ADDRESS'}},{id:kyc.id});
  assert.equal(result.status,200);assert.equal(result.data.sharing.site_count,3);assert.deepEqual(result.data.sharing.warnings,[]);
  const linked=(await query('SELECT * FROM members WHERE shared_profile_id=$1',[source.shared_profile_id])).rows;
  assert.equal(linked.length,3);assert.ok(linked.every(row=>row.full_name==='VERIFIED CLIENT' && row.aadhar_no==='123456789123' && row.address==='REVIEWED ADDRESS'));
  assert.deepEqual((await query('SELECT full_name,shared_profile_id FROM members WHERE id=ANY($1::int[]) ORDER BY id',[[unrelated.id,otherOrg.id]])).rows,
    [{full_name:'OTHER CLIENT',shared_profile_id:null},{full_name:'Test Client',shared_profile_id:null}]);
  assert.equal((await query('SELECT count(*)::int AS n FROM documents WHERE client_member_id=$1',[unrelated.id])).rows[0].n,0);
});

test('verifying a legacy registration links the same name/mobile copies and replaces stale KYC with the reviewed corrections',async t=>{
  const {db,query}=await fixture(t);
  const source=await memberModel.create(data({full_name:'ANKIT TYAGI',phone:'9639559955',alt_phone:'9000000001'}),db);
  const existing=await memberModel.create(data({site_id:2,full_name:'ANKIT TYAGI',phone:'9639559955',member_type:'FARMER',member_types:['FARMER'],aadhar_no:'1234567890123',address:'OLD ADDRESS',alt_phone:'9000000002',notes:'SITE NOTE'}),db);
  await verifiedCase(db,existing);
  const kyc=await verifiedCase(db,source,{status:'OPEN'});
  const result=await invoke(verifyCase,{member_update:{full_name:'ANKIT KUMAR TYAGI',phone:'9639559956',aadhar_no:'234567891234',address:'NEW REVIEWED ADDRESS',alt_phone:''}},{id:kyc.id});
  assert.equal(result.status,200);assert.equal(result.data.sharing.site_count,3);
  assert.equal(result.data.sharing.created_count,1);
  const linked=(await query('SELECT * FROM members ORDER BY site_id')).rows;
  assert.equal(linked.length,3);assert.equal(new Set(linked.map(row=>row.shared_profile_id)).size,1);
  assert.ok(linked.every(row=>row.full_name==='ANKIT KUMAR TYAGI' && row.phone==='9639559956' && row.aadhar_no==='234567891234' && row.address==='NEW REVIEWED ADDRESS' && row.alt_phone===null));
  assert.deepEqual(linked[1].member_types,['FARMER']);assert.equal(linked[1].notes,'SITE NOTE');
  assert.equal((await query("SELECT count(*)::int AS n FROM kyc_cases WHERE status='VERIFIED'")).rows[0].n,4);
});

test('an unchanged mobile on a legacy duplicate does not block the selected member KYC',async t=>{
  const {db,query}=await fixture(t);
  const source=(await invoke(createMember,{site_id:1,full_name:'Test Client',phone:'9876543210'})).data.member;
  const duplicate=await memberModel.create(data({full_name:'OLD UNLINKED COPY'}),db);
  const kyc=await verifiedCase(db,source,{status:'OPEN'});
  assert.equal((await invoke(verifyCase,{member_update:{phone:'9876543210',address:'VERIFIED ADDRESS'}},{id:kyc.id})).status,200);
  assert.equal((await query('SELECT address FROM members WHERE id=$1',[duplicate.id])).rows[0].address,null);
});

test('another person using the mobile in a target site produces a sharing warning after successful local verification',async t=>{
  const {db,query}=await fixture(t);
  const source=await memberModel.create(data(),db);
  const other=await memberModel.create(data({site_id:2,full_name:'ANOTHER PERSON'}),db);
  const kyc=await verifiedCase(db,source,{status:'OPEN'});
  const result=await invoke(verifyCase,{member_update:{address:'VERIFIED ADDRESS'}},{id:kyc.id});
  assert.equal(result.status,200);assert.equal(result.data.sharing.site_count,2);
  assert.deepEqual(result.data.sharing.warnings.map(w=>[w.site_id,w.code]),[[2,'SITE_MOBILE_CONFLICT']]);
  assert.equal((await query('SELECT status FROM kyc_cases WHERE id=$1',[kyc.id])).rows[0].status,'VERIFIED');
  assert.equal((await query('SELECT full_name,address,shared_profile_id FROM members WHERE id=$1',[other.id])).rows[0].shared_profile_id,null);
  assert.equal((await query('SELECT count(*)::int AS n FROM members WHERE site_id=2')).rows[0].n,1);
});

test('duplicate legacy matches are not guessed or merged while the source verification saves',async t=>{
  const {db,query}=await fixture(t);
  const source=await memberModel.create(data(),db);
  await memberModel.create(data({site_id:2}),db);await memberModel.create(data({site_id:2}),db);
  const kyc=await verifiedCase(db,source,{status:'OPEN'});
  const result=await invoke(verifyCase,{member_update:{address:'VERIFIED ADDRESS'}},{id:kyc.id});
  assert.equal(result.status,200);assert.equal(result.data.sharing.warnings[0].code,'REGISTRATION_REVIEW_REQUIRED');
  assert.equal((await query('SELECT count(*)::int AS n FROM members WHERE site_id=2 AND shared_profile_id IS NULL')).rows[0].n,2);
});

test('a document-copy failure rolls back the reviewed profile and verification together',async t=>{
  const {db,query}=await fixture(t);
  const source=(await invoke(createMember,{site_id:1,full_name:'Test Client',phone:'9876543210'})).data.member;
  const kyc=await verifiedCase(db,source,{status:'OPEN'});
  await query('ALTER TABLE documents ADD CONSTRAINT reject_target_documents CHECK(site_id<>3)');
  await assert.rejects(invoke(verifyCase,{member_update:{address:'VERIFIED ADDRESS'}},{id:kyc.id}),/reject_target_documents/);
  assert.equal((await query('SELECT status FROM kyc_cases WHERE id=$1',[kyc.id])).rows[0].status,'OPEN');
  assert.ok((await query('SELECT address FROM members')).rows.every(row=>row.address===null));
});

test('later KYC verification updates the consolidated member and every other linked site',async t=>{
  const {db,query}=await fixture(t);
  const source=(await invoke(createMember,{site_id:1,full_name:'Test Client',phone:'9876543210'})).data.member;
  const duplicate=await memberModel.create(data({full_name:'OLD TEST CLIENT',member_types:['PARTNER'],member_type:'PARTNER'}),db);
  const reviewed=await reviewMemberIdentity(db,{memberId:source.id,user,phone:source.phone});
  const link=await invoke(updateMember,{full_name:'TEST CLIENT',phone:source.phone,
    same_person_confirmed:'true',identity_profile_member_id:source.id,identity_member_ids:reviewed.registrations.map(row=>row.id),identity_revision:reviewed.summary.revision},{id:source.id});
  assert.equal(link.status,200);assert.equal(link.data.identity_link.registration_count,4);
  const kyc=await verifiedCase(db,source,{status:'OPEN'});
  const result=await invoke(verifyCase,{member_update:{full_name:'REVIEWED TEST CLIENT',address:'VERIFIED ADDRESS'}},{id:kyc.id});
  assert.equal(result.status,200);
  const members=(await query('SELECT full_name,address FROM members')).rows;
  assert.equal(members.length,3);assert.ok(members.every(row=>row.full_name==='REVIEWED TEST CLIENT' && row.address==='VERIFIED ADDRESS'));
  assert.equal((await query("SELECT count(DISTINCT client_member_id)::int AS n FROM kyc_cases WHERE status='VERIFIED'")).rows[0].n,3);
  assert.deepEqual((await query('SELECT member_types FROM members WHERE id=$1',[source.id])).rows[0].member_types,['CLIENT','PARTNER']);
  assert.equal((await query('SELECT canonical_member_id FROM member_identity_aliases WHERE member_id=$1',[duplicate.id])).rows[0].canonical_member_id,source.id);
});
