import assert from 'node:assert/strict';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { migrationSql } from '../src/migrations/222_seek_permissions.js';
import {
  cancelSeekPermission, createSeekPermission, decideSeekPermission, listSeekAccess, listSeekPermissions,
  markSeekSeen, seekInbox, seekRecipients, setSeekAccess,
} from '../src/services/seekPermission.service.js';

test('Seek permission: sub-admins ask per site, admins decide once, Studio controls who sees what', async () => {
  const db = new PGlite();
  const admin = { id: 1, role: 'admin', organization_id: 1 };
  const ravi = { id: 5, role: 'sub_admin', organization_id: 1 };
  const sunny = { id: 6, role: 'sub_admin', organization_id: 1 };
  const outsider = { id: 7, role: 'sub_admin', organization_id: 1 }; // not on site 1
  const foreignAdmin = { id: 9, role: 'admin', organization_id: 2 };
  const rejects = (promise, statusCode) => assert.rejects(promise, error => error.statusCode === statusCode);
  try {
    await db.exec(`CREATE TABLE sites(id int PRIMARY KEY, name text, organization_id int);
      CREATE TABLE users(id int PRIMARY KEY, name text, role text, organization_id int, is_active boolean);
      CREATE TABLE user_sites(user_id int, site_id int);
      INSERT INTO sites VALUES (1, 'Green River', 1), (2, 'Mount Valley', 1);
      INSERT INTO users VALUES (1, 'Kuldeep Tomar', 'admin', 1, true), (5, 'Ravi Siwach', 'sub_admin', 1, true),
        (6, 'Sunny', 'sub_admin', 1, true), (7, 'Outsider', 'sub_admin', 1, true), (9, 'Other org', 'admin', 2, true);
      INSERT INTO user_sites VALUES (5, 1), (6, 1), (7, 2), (5, 2);
      ${migrationSql}`);

    // Ask: only sub-admins, only on an assigned site, with a real request.
    const asked = await createSeekPermission(ravi, { site_id: 1, title: ' Payment to shuttering contractor ', amount: '500000', party_name: 'Rakesh', reason: 'Block C advance' }, db);
    assert.equal(asked.status, 'pending');
    assert.equal(asked.title, 'Payment to shuttering contractor');
    assert.equal(Number(asked.amount), 500000);
    assert.equal(asked.requested_by_name, 'Ravi Siwach');
    await rejects(createSeekPermission(admin, { site_id: 1, title: 'x' }, db), 403);
    await rejects(createSeekPermission(outsider, { site_id: 1, title: 'x' }, db), 403);
    await rejects(createSeekPermission(ravi, { site_id: 1, title: '   ' }, db), 400);
    await rejects(createSeekPermission(ravi, { site_id: 1, title: 'x', amount: -5 }, db), 400);
    await rejects(createSeekPermission(ravi, { site_id: 'abc', title: 'x' }, db), 400);
    const otherSite = await createSeekPermission(ravi, { site_id: 2, title: 'Cement purchase' }, db);

    // Bell: the admin receives the site's open requests; Ravi tracks his own. Site-scoped.
    assert.deepEqual((await seekInbox(admin, { site_id: 1 }, db)).received.map(r => r.id), [asked.id]);
    assert.deepEqual((await seekInbox(ravi, { site_id: 1 }, db)).sent.map(r => r.id), [asked.id]);
    assert.deepEqual((await seekInbox(ravi, { site_id: 2 }, db)).sent.map(r => r.id), [otherSite.id]);
    assert.deepEqual((await seekInbox(foreignAdmin, { site_id: 1 }, db)).received, []);

    // Studio: Sunny sees only his own until allowed; 'selected' and 'all' open it per site.
    const sees = async (actor, siteId = 1) => (await listSeekPermissions(actor, { site_id: siteId }, db)).map(r => r.id);
    assert.deepEqual(await sees(sunny), []);
    assert.deepEqual((await listSeekAccess(admin, { site_id: 1 }, db)).map(u => [u.id, u.scope]), [[5, 'own'], [6, 'own']]);
    const selected = await setSeekAccess(admin, 6, { site_id: 1, scope: 'selected', user_ids: [5, 6, 7, 5] }, db);
    assert.deepEqual(selected.user_ids, [5], 'self and people outside the site are dropped');
    assert.deepEqual(await sees(sunny), [asked.id]);
    await setSeekAccess(admin, 6, { site_id: 1, scope: 'own' }, db);
    assert.deepEqual(await sees(sunny), []);
    await setSeekAccess(admin, 6, { site_id: 1, scope: 'all' }, db);
    assert.deepEqual(await sees(sunny), [asked.id]);
    assert.deepEqual(await sees(sunny, 2), [], 'a site Sunny is not assigned to stays hidden');
    assert.deepEqual((await seekRecipients(asked, db)).sort(), [1, 5, 6]);
    await rejects(setSeekAccess(admin, 7, { site_id: 1, scope: 'all' }, db), 404);
    await rejects(setSeekAccess(admin, 6, { site_id: 1, scope: 'everyone' }, db), 400);
    await rejects(setSeekAccess(ravi, 6, { site_id: 1, scope: 'all' }, db), 403);
    await rejects(listSeekAccess(ravi, { site_id: 1 }, db), 403);
    assert.equal((await seekInbox(sunny, { site_id: 1 }, db)).sent.length, 0, 'visibility never puts others in the bell');

    // Decide: admins only, own organisation only, first decision wins.
    await rejects(decideSeekPermission(ravi, asked.id, 'approve', '', db), 403);
    await rejects(decideSeekPermission(foreignAdmin, asked.id, 'approve', '', db), 404);
    await rejects(decideSeekPermission(admin, asked.id, 'maybe', '', db), 400);
    const approved = await decideSeekPermission(admin, asked.id, 'approve', 'Pay by cheque', db);
    assert.equal(approved.status, 'approved');
    assert.equal(approved.decided_by_name, 'Kuldeep Tomar');
    assert.equal(approved.decision_note, 'Pay by cheque');
    await rejects(decideSeekPermission(admin, asked.id, 'reject', '', db), 409);
    await rejects(cancelSeekPermission(ravi, asked.id, db), 409);
    assert.deepEqual((await seekInbox(admin, { site_id: 1 }, db)).received, []);

    // Ravi's bell clears once he has seen the decision.
    assert.equal(await markSeekSeen(ravi, { site_id: 1 }, db), 1);
    assert.equal(await markSeekSeen(ravi, { site_id: 1 }, db), 0);

    // Withdraw: only the requester, only while pending.
    await rejects(cancelSeekPermission(sunny, otherSite.id, db), 404);
    assert.equal((await cancelSeekPermission(ravi, otherSite.id, db)).status, 'cancelled');
    await rejects(decideSeekPermission(admin, otherSite.id, 'approve', '', db), 409);
  } finally { await db.close(); }
});
