import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { listCommissionReceivers } from '../src/services/commissionReceivers.service.js';

test('receiver pages group site/role registrations before pagination and prefer the local active broker', async t => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(`CREATE TABLE sites(id int PRIMARY KEY,organization_id int);
    CREATE TABLE members(id int PRIMARY KEY,site_id int,full_name text,phone text,member_type text,member_types text[],aadhar_no text,pan_no text,status text,is_active boolean DEFAULT true);
    INSERT INTO sites VALUES(1,1),(2,1),(3,1),(4,2);
    INSERT INTO members(id,site_id,full_name,phone,member_type,aadhar_no,status) VALUES
      (1,1,'Pravindra Kumar (Lilon)','9808587308','CLIENT','234567890123','ACTIVE'),
      (2,2,'PRAVINDRA KUMAR ( LILON )','+91 98085 87308','BROKER','2345 6789 0123','ACTIVE'),
      (3,1,'Pravindra Kumar Lilon','09808587308','BROKER','234567890123','DISABLED'),
      (4,3,'Pravindra K-umar (Lilon)','0091 98085 87308','BROKER','234567890123','ACTIVE'),
      (5,2,'Pravindra Kumar Lilon','98085-87308','CLIENT',NULL,'ACTIVE'),
      (6,1,'PRAVINDRA KUMAR (LILON)','9808587308','BROKER','234567890123','ACTIVE'),
      (7,1,'Pravindra Kumar (Lilon)','9876500007','CLIENT',NULL,'ACTIVE'),
      (8,1,'Another Person','9808587308','BROKER','345678901234','ACTIVE'),
      (9,4,'Pravindra Kumar (Lilon)','9808587308','BROKER','234567890123','ACTIVE');`);
  const read = extra => listCommissionReceivers(db, { organizationId: 1, siteId: 1, ...extra });
  const first = await read({ query: 'pravin', limit: 1 });
  assert.equal(first.members.length, 1);
  assert.equal(first.members[0].id, 6, 'The chosen receiver is the active broker registered at this site');
  assert.equal(first.members[0].partner_app_eligible, true);
  assert.deepEqual(first.members[0].member_ids, [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(first.members[0].member_types, ['BROKER', 'CLIENT']);
  assert.equal(first.next_cursor, '1', 'Page cursor follows the person, not the preferred registration ID');
  const next = await read({ query: 'pravin', limit: 1, cursor: Number(first.next_cursor) });
  assert.deepEqual(next.members.map(row => row.id), [7], 'Other people with the same name remain selectable');
  assert.equal(next.next_cursor, null);
  const phone = await read({ query: '+91 98085 87308' });
  assert.deepEqual(phone.members.map(row => row.id), [6, 8], 'Different people sharing a phone are not collapsed');
  const variant = await read({ query: 'K-umar' });
  assert.equal(variant.members[0].id, 6, 'Searching a registration alias still selects the same broker');
  assert.equal(variant.members[0].member_ids.length, 6);
  assert.equal(JSON.stringify(phone).includes('234567890123'), false, 'Private identity data never leaves the directory');
  assert.equal(first.directory_version, 2);
});

test('blank/dummy phones and conflicting identities never merge distinct registrations', async t => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(`CREATE TABLE sites(id int PRIMARY KEY,organization_id int);
    CREATE TABLE members(id int PRIMARY KEY,site_id int,full_name text,phone text,member_type text,member_types text[],aadhar_no text,pan_no text);
    INSERT INTO sites VALUES(1,1);
    INSERT INTO members VALUES
      (1,1,'No mobile',NULL,'CLIENT',NULL,NULL,NULL),(2,1,'No mobile','','CLIENT',NULL,NULL,NULL),
      (3,1,'Dummy mobile','0000000000','CLIENT',NULL,NULL,NULL),(4,1,'Dummy mobile','0000000000','CLIENT',NULL,NULL,NULL),
      (5,1,'Identity conflict','9876500005','BROKER',NULL,'234567890123',NULL),
      (6,1,'Identity conflict','9876500005','BROKER',NULL,'345678901234',NULL),
      (7,1,'PAN conflict','9876500007','CLIENT',NULL,NULL,'ABCDE1234F'),
      (8,1,'PAN conflict','9876500007','CLIENT',NULL,NULL,'ABCDE5678G');`);
  const result = await listCommissionReceivers(db, { organizationId: 1, siteId: 1 });
  assert.deepEqual(result.members.map(row => row.id), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.ok(result.members.every(row => row.member_ids.length === 1));
});
