import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { getMemberLinks } from '../src/services/memberLinks.service.js';

async function fixture(t) {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(`
    CREATE TABLE sites(id INT PRIMARY KEY, name TEXT, organization_id INT);
    INSERT INTO sites VALUES (1,'Current',1),(2,'Shared',1),(3,'Mobile collision',1),(4,'Other organisation',2);
    CREATE TABLE user_sites(user_id INT,site_id INT); INSERT INTO user_sites VALUES(7,1);
    CREATE TABLE members(id INT PRIMARY KEY,site_id INT,full_name TEXT,phone TEXT,aadhar_no TEXT,pan_no TEXT,
      shared_profile_id UUID,father_name TEXT,date_of_birth DATE);
    INSERT INTO members VALUES
      (1,1,'CLIENT NAME','9000000001',NULL,NULL,'00000000-0000-0000-0000-000000000001',NULL,NULL),
      (2,2,'REVIEWED NAME',NULL,NULL,NULL,'00000000-0000-0000-0000-000000000001',NULL,NULL),
      (3,3,'DIFFERENT PERSON','9000000001',NULL,NULL,NULL,NULL,NULL),
      (4,1,'CLIENT NAME','9000000004',NULL,NULL,NULL,NULL,NULL),
      (5,4,'CLIENT NAME','9000000001',NULL,NULL,'00000000-0000-0000-0000-000000000001',NULL,NULL);
    CREATE TABLE kyc_cases(id INT PRIMARY KEY,client_member_id INT,site_id INT,status TEXT,updated_at TIMESTAMPTZ);
    INSERT INTO kyc_cases VALUES(1,1,1,'OCR_PENDING',now()),(2,2,2,'VERIFIED',now()),(3,2,2,'OPEN',now());
    CREATE TABLE plots(id INT PRIMARY KEY,site_id INT,plot_no TEXT,plot_tag TEXT,buyer_member_id INT,buyer_name TEXT,booking_by TEXT);
    INSERT INTO plots VALUES (101,1,'A1',NULL,1,'STALE NAME',NULL),(102,1,'A2',NULL,4,'CLIENT NAME',NULL),
      (104,1,'A4',NULL,4,'CLIENT NAME',NULL),(105,4,'A5',NULL,5,'CLIENT NAME',NULL);
    CREATE TABLE bookings(id INT PRIMARY KEY,site_id INT,plot_id INT,client_member_id INT,status TEXT);
    CREATE TABLE plot_commissions(id INT,site_id INT,plot_no TEXT,particular TEXT);
    CREATE TABLE plot_commissions_v2(id INT,site_id INT,plot_id INT,agent_id INT);
    INSERT INTO plot_commissions_v2 VALUES(1,1,104,1);
    CREATE TABLE plot_registries(id INT,site_id INT,plot_id INT,customer_name TEXT,farmer_name TEXT,noc_client_member_ids INT[]);
    INSERT INTO plot_registries VALUES(201,1,101,'STALE NAME',NULL,NULL),(202,1,102,'CLIENT NAME',NULL,NULL),(203,1,NULL,NULL,NULL,ARRAY[1]);
    CREATE TABLE transaction_party_links(site_id INT,member_id INT,source_key TEXT,source_id INT);
    CREATE TABLE expenses(id INT,site_id INT,from_entity TEXT,to_entity TEXT,mapped_member_id INT,mapped_user_id INT,assigned_user_id INT,created_by INT);
    INSERT INTO expenses VALUES(501,1,'OTHER','STALE NAME',1,NULL,NULL,7),(502,1,'OTHER','CLIENT NAME',4,NULL,NULL,7),
      (503,1,'OTHER','CLIENT NAME',NULL,NULL,NULL,7),(504,1,'OTHER','OTHER',NULL,NULL,NULL,7),
      (505,4,'OTHER','CLIENT NAME',1,NULL,NULL,7),(506,1,'OTHER','STALE NAME',1,NULL,NULL,8);
    INSERT INTO transaction_party_links VALUES(1,1,'expense',504);
    CREATE TABLE day_book(id INT,site_id INT,from_entity TEXT,to_entity TEXT,mapped_member_id INT,mapped_user_id INT,assigned_user_id INT,created_by INT,expense_id INT);
    INSERT INTO day_book VALUES(601,1,'OTHER','STALE NAME',1,NULL,NULL,7,501),(602,1,'OTHER','STALE NAME',1,NULL,NULL,7,501),
      (603,1,'OTHER','CLIENT NAME',4,NULL,NULL,7,NULL);
    CREATE TABLE farmers(id INT,site_id INT,member_id INT,name TEXT); INSERT INTO farmers VALUES(301,1,1,'STALE NAME'),(302,1,4,'CLIENT NAME');
    CREATE TABLE cash_flow_months(id INT,site_id INT,linked_member_id INT); INSERT INTO cash_flow_months VALUES(401,1,1),(402,1,4);
    CREATE TABLE cash_flow_entries(id INT,cash_flow_month_id INT);
    CREATE TABLE firms(id INT,site_id INT); INSERT INTO firms VALUES(1,1);
    CREATE TABLE firm_transactions(id INT,firm_id INT,name TEXT,mapped_member_id INT,mapped_user_id INT);
    INSERT INTO firm_transactions VALUES(701,1,'STALE NAME',1,NULL),(702,1,'CLIENT NAME',4,NULL);
    CREATE TABLE vendor_commitments(id INT,site_id INT,vendor_member_id INT,vendor_name TEXT);
    INSERT INTO vendor_commitments VALUES(801,1,1,'STALE NAME'),(802,1,4,'CLIENT NAME');
    CREATE TABLE vendor_inventory_orders(id INT,site_id INT,vendor_member_id INT,vendor_name TEXT,created_by INT);
    INSERT INTO vendor_inventory_orders VALUES(901,1,1,'STALE NAME',7);
    CREATE TABLE misc_income_entries(id INT,site_id INT,party_name TEXT,created_by INT);
    INSERT INTO misc_income_entries VALUES(1001,1,'OTHER',7),(1002,1,'CLIENT NAME',7);
    INSERT INTO transaction_party_links VALUES(1,1,'misc_income_entry',1001);
  `);
  return db;
}

test('counts real module records, unpaid commissions and shared registrations without same-name or mobile collisions', async t => {
  const db = await fixture(t);
  const data = await getMemberLinks(db, { memberId: 1, user: { role: 'admin', organization_id: 1 } });
  assert.equal(data.modules.length, 11);
  const modules = new Map(data.modules.map(module => [module.key, module]));
  assert.deepEqual(modules.get('plot_payments').record_ids.sort(), [101,104]);
  assert.deepEqual(modules.get('commissions').record_ids, [104]);
  assert.deepEqual(modules.get('expenses').record_ids.sort(), [501,504,506]);
  assert.deepEqual(modules.get('plot_registry').record_ids.sort(), [201,203]);
  assert.equal(modules.get('daybook').count, 1, 'copies of the same module entry count once');
  assert.deepEqual(modules.get('daybook').record_keys, ['expenses:501']);
  assert.deepEqual(modules.get('firm_transactions').parent_ids, [1]);
  assert.deepEqual(modules.get('misc_income').record_ids, [1001]);
  assert.deepEqual(data.sites.map(site => [site.id,site.member_id,site.kyc_status]), [[1,1,'OCR_PENDING'],[2,2,'VERIFIED']]);
});

test('keeps site and module permissions and creator visibility on linked reads', async t => {
  const db = await fixture(t);
  const user = { id: 7, role: 'sub_admin', organization_id: 1 };
  const data = await getMemberLinks(db, { memberId: 1, user, permissions: new Map([['expenses',{can_read:true,can_view_all:false}]]) });
  assert.deepEqual(data.modules.map(module => module.key), ['expenses']);
  assert.deepEqual(data.modules[0].record_ids.sort(), [501,504]);
  assert.deepEqual(data.sites.map(site => site.id), [1]);
  await assert.rejects(getMemberLinks(db, { memberId: 2, user }), { statusCode: 403 });
  await assert.rejects(getMemberLinks(db, { memberId: 1, siteId: 2, user }), { statusCode: 400 });
});

test('combines modules across sites and provides the local registration for each destination', async t => {
  const db = await fixture(t);
  await db.exec(`INSERT INTO plots VALUES(106,2,'B1',NULL,2,'REVIEWED NAME',NULL);
    INSERT INTO plot_commissions_v2 VALUES(2,2,106,2);`);
  const data = await getMemberLinks(db, { memberId: 1, allSites: true, user: { role: 'admin', organization_id: 1 } });
  const project = data.modules.find(module => module.key === 'plot_payments');
  assert.equal(project.count, 3);
  assert.deepEqual(project.site_links.map(site => [site.site_id,site.member_id,site.count]), [[1,1,2],[2,2,1]]);
  const local = await getMemberLinks(db, { memberId: 2, siteId: 2, user: { role: 'admin', organization_id: 1 } });
  assert.deepEqual(local.modules.find(module => module.key === 'plot_payments').record_ids, [106]);
});

test('does not treat a name alone as a site identity or override an explicitly linked registry buyer', async t => {
  const db = await fixture(t);
  await db.exec(`INSERT INTO members VALUES(6,1,'NO CONTACT',NULL,NULL,NULL,NULL,NULL,NULL),(7,2,'NO CONTACT',NULL,NULL,NULL,NULL,NULL,NULL);
    UPDATE members SET full_name='UNIQUE CLIENT' WHERE id=1;
    UPDATE plot_registries SET customer_name='UNIQUE CLIENT' WHERE id=202;`);
  const user = { role: 'admin', organization_id: 1 };
  const unnamed = await getMemberLinks(db, { memberId: 6, allSites: true, user });
  assert.deepEqual(unnamed.sites.map(site => site.id), [1]);
  const data = await getMemberLinks(db, { memberId: 1, user });
  assert.deepEqual(data.modules.find(module => module.key === 'plot_registry').record_ids.sort(), [201,203]);
});
