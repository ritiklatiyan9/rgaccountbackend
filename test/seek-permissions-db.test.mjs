import assert from 'node:assert/strict';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { migrationSql } from '../src/migrations/222_seek_permissions.js';
import { migrationSql as targetsSql } from '../src/migrations/223_seek_permission_targets.js';
import { migrationSql as commentsSql } from '../src/migrations/230_seek_permission_comments.js';
import { migrationSql as prioritySql, up as migratePriority } from '../src/migrations/231_seek_permission_priority.js';
import {
  cancelSeekPermission, createSeekPermission, decideSeekPermission, isOwnSeekAttachment, listSeekAccess,
  listSeekPermissions, listSeekTargets, markSeekSeen, seekAttachmentUrl, seekInbox, seekRecipients, setSeekAccess,
} from '../src/services/seekPermission.service.js';

test('Seek permission: ask a chosen person per site, they (or an admin) decide once, Studio controls who sees what', async () => {
  const db = new PGlite();
  const admin = { id: 1, role: 'admin', organization_id: 1 };
  const ravi = { id: 5, role: 'sub_admin', organization_id: 1 };
  const sunny = { id: 6, role: 'sub_admin', organization_id: 1 };
  const outsider = { id: 7, role: 'sub_admin', organization_id: 1 }; // not on site 1
  const foreignAdmin = { id: 9, role: 'admin', organization_id: 2 };
  const rejects = (promise, statusCode) => assert.rejects(promise, error => error.statusCode === statusCode);
  const pdf = { path: '/tmp/x', filename: 'q.pdf', originalname: 'quotation.pdf', mimetype: 'application/pdf', size: 1234 };
  const fakeStore = async files => files.map(file => ({ url: `https://b.s3.ap-south-1.amazonaws.com/seek-permissions/${file.filename}`,
    name: file.originalname, type: file.mimetype, size: file.size }));
  const ask = (actor, body, files = [], store = fakeStore) => createSeekPermission(actor, { site_id: 1, asked_to: 1, title: 'x', ...body }, db, files, store);
  try {
    await db.exec(`CREATE TABLE sites(id int PRIMARY KEY, name text, organization_id int);
      CREATE TABLE users(id int PRIMARY KEY, name text, role text, organization_id int, is_active boolean);
      CREATE TABLE user_sites(user_id int, site_id int);
      INSERT INTO sites VALUES (1, 'Green River', 1), (2, 'Mount Valley', 1);
      INSERT INTO users VALUES (1, 'Kuldeep Tomar', 'admin', 1, true), (5, 'Ravi Siwach', 'sub_admin', 1, true),
        (6, 'Sunny', 'sub_admin', 1, true), (7, 'Outsider', 'sub_admin', 1, true), (8, 'Gone', 'sub_admin', 1, false),
        (9, 'Other org', 'admin', 2, true);
      INSERT INTO user_sites VALUES (5, 1), (6, 1), (7, 2), (5, 2), (8, 1);
      ${migrationSql}
      ${targetsSql}
      ${commentsSql} ${prioritySql}`);

    // Picker: admins plus active sub-admins of the site, never yourself.
    assert.deepEqual((await listSeekTargets(ravi, { site_id: 1 }, db)).map(p => [p.name, p.role]),
      [['Kuldeep Tomar', 'admin'], ['Sunny', 'sub_admin']]);
    assert.deepEqual(await listSeekTargets(outsider, { site_id: 1 }, db), [], 'no picker for a site you are not on');
    for (const asked_to of [undefined, 7, 5, 8, 9]) await rejects(ask(ravi, { asked_to }), 400);

    // Ask: only sub-admins, only on an assigned site; checks run before anything is uploaded.
    let uploads = 0;
    const countingStore = async files => { uploads += files.length; return fakeStore(files); };
    await rejects(ask(ravi, { asked_to: 7 }, [pdf], countingStore), 400);
    await rejects(ask(outsider, {}, [pdf], countingStore), 403);
    await rejects(ask(admin, {}, [pdf], countingStore), 403);
    await rejects(ask(ravi, { title: '   ' }, [pdf], countingStore), 400);
    await rejects(ask(ravi, { amount: -5 }, [pdf], countingStore), 400);
    for (const priority of ['urgent','__proto__',{},['critical'],42]) await rejects(ask(ravi, { priority }, [pdf], countingStore), 400);
    assert.equal(uploads, 0, 'a refused request never reaches S3');

    const asked = await ask(ravi, { title: ' Payment to shuttering contractor ', amount: '500000', party_name: 'Rakesh', reason: 'Block C advance' }, [pdf], countingStore);
    assert.equal(uploads, 1);
    assert.equal(asked.status, 'pending');
    assert.equal(asked.priority, 'normal', 'older clients default to Normal');
    assert.equal(asked.title, 'Payment to shuttering contractor');
    assert.equal(Number(asked.amount), 500000);
    assert.equal(asked.asked_to_name, 'Kuldeep Tomar');
    assert.deepEqual(asked.attachments, [{ name: 'quotation.pdf', type: 'application/pdf', size: 1234 }], 'stored S3 URLs never leave the server');
    const toSunny = await ask(ravi, { asked_to: 6, title: 'Use the site JCB on Sunday', priority: ' CRITICAL ' });
    const otherSite = await ask(ravi, { site_id: 2, title: 'Cement purchase', priority: 'important' });
    assert.equal(toSunny.priority, 'critical'); assert.equal(otherSite.priority, 'important');

    // Bell: visible pending requests match the page and socket audience. Site-scoped.
    const received = async (actor, siteId = 1) => (await seekInbox(actor, { site_id: siteId }, db)).received.map(r => r.id);
    assert.deepEqual(await received(admin), [toSunny.id, asked.id], 'admins can follow and decide any visible request');
    assert.equal((await seekInbox(admin, { site_id: 1 }, db)).received.find(row => row.id === toSunny.id).priority, 'critical');
    assert.deepEqual(await received(sunny), [toSunny.id]);
    assert.deepEqual((await seekInbox(ravi, { site_id: 1 }, db)).sent.map(r => r.id), [toSunny.id, asked.id]);
    assert.deepEqual((await seekInbox(ravi, { site_id: 2 }, db)).sent.map(r => r.id), [otherSite.id]);
    assert.deepEqual(await received(foreignAdmin), []);

    // Page visibility: admins see all; the person asked sees it; Studio opens the rest per site.
    const sees = async (actor, siteId = 1) => (await listSeekPermissions(actor, { site_id: siteId }, db)).map(r => r.id);
    assert.deepEqual(await sees(admin), [toSunny.id, asked.id]);
    assert.deepEqual(await sees(sunny), [toSunny.id], 'asked of him, not the rest');
    assert.deepEqual((await listSeekAccess(admin, { site_id: 1 }, db)).map(u => [u.id, u.scope]), [[5, 'own'], [6, 'own']]);
    const selected = await setSeekAccess(admin, 6, { site_id: 1, scope: 'selected', user_ids: [5, 6, 7, 5] }, db);
    assert.deepEqual(selected.user_ids, [5], 'self and people outside the site are dropped');
    assert.deepEqual(await sees(sunny), [toSunny.id, asked.id]);
    await setSeekAccess(admin, 6, { site_id: 1, scope: 'own' }, db);
    assert.deepEqual(await sees(sunny), [toSunny.id]);
    await setSeekAccess(admin, 6, { site_id: 1, scope: 'all' }, db);
    assert.deepEqual(await sees(sunny, 2), [], 'a site Sunny is not assigned to stays hidden');
    assert.deepEqual((await seekRecipients(toSunny, db)).sort(), [1, 5, 6]);
    await rejects(setSeekAccess(admin, 7, { site_id: 1, scope: 'all' }, db), 404);
    await rejects(setSeekAccess(admin, 6, { site_id: 1, scope: 'everyone' }, db), 400);
    await rejects(setSeekAccess(ravi, 6, { site_id: 1, scope: 'all' }, db), 403);
    await rejects(listSeekAccess(ravi, { site_id: 1 }, db), 403);

    // Attachments: a fresh signed link per view, only for people who can see the request,
    // and only for keys under the module's own S3 prefix.
    const sign = async url => `signed:${url}`;
    assert.equal((await seekAttachmentUrl(sunny, asked.id, 0, db, sign)).url, 'signed:https://b.s3.ap-south-1.amazonaws.com/seek-permissions/q.pdf');
    await rejects(seekAttachmentUrl(outsider, asked.id, 0, db, sign), 404);
    await rejects(seekAttachmentUrl(admin, asked.id, 1, db, sign), 404);
    await rejects(seekAttachmentUrl(admin, asked.id, 'x', db, sign), 404);
    const env = { AWS_S3_BUCKET_NAME: 'b', AWS_REGION: 'ap-south-1' };
    assert.equal(isOwnSeekAttachment('https://b.s3.ap-south-1.amazonaws.com/seek-permissions/q.pdf', env), true);
    assert.equal(isOwnSeekAttachment('https://b.s3.ap-south-1.amazonaws.com/vouchers/kyc.pdf', env), false);
    assert.equal(isOwnSeekAttachment('https://evil.s3.ap-south-1.amazonaws.com/seek-permissions/q.pdf', env), false);

    // Decide: the person asked (or an admin), own organisation only, first decision wins.
    await rejects(decideSeekPermission(ravi, asked.id, 'approve', '', db), 403);
    await rejects(decideSeekPermission(sunny, asked.id, 'approve', '', db), 403, 'Sunny may follow it, not decide it');
    await rejects(decideSeekPermission(outsider, asked.id, 'approve', '', db), 404);
    await rejects(decideSeekPermission(foreignAdmin, asked.id, 'approve', '', db), 404);
    await rejects(decideSeekPermission(admin, asked.id, 'maybe', '', db), 400);
    const criticalApproved = await decideSeekPermission(sunny, toSunny.id, 'approve', '', db);
    assert.equal(criticalApproved.decided_by_name, 'Sunny'); assert.equal(criticalApproved.priority, 'critical');
    const approved = await decideSeekPermission(admin, asked.id, 'approve', 'Pay by cheque', db);
    assert.equal(approved.status, 'approved');
    assert.equal(approved.decided_by_name, 'Kuldeep Tomar');
    assert.equal(approved.decision_note, 'Pay by cheque');
    await rejects(decideSeekPermission(admin, asked.id, 'reject', '', db), 409);
    await rejects(cancelSeekPermission(ravi, asked.id, db), 409);
    assert.deepEqual(await received(admin), []);
    const override = await ask(ravi, { asked_to: 6, title: 'Diesel advance' });
    assert.equal((await decideSeekPermission(admin, override.id, 'reject', 'Not this week', db)).status, 'rejected', 'admins can decide any request');

    // Ravi's bell clears once he has seen the decisions.
    assert.equal(await markSeekSeen(ravi, { site_id: 1 }, db), 3);
    assert.equal(await markSeekSeen(ravi, { site_id: 1 }, db), 0);

    // Withdraw: only the requester, only while pending.
    await rejects(cancelSeekPermission(sunny, otherSite.id, db), 404);
    assert.equal((await cancelSeekPermission(ravi, otherSite.id, db)).status, 'cancelled');
    await rejects(decideSeekPermission(admin, otherSite.id, 'approve', '', db), 409);
  } finally { await db.close(); }
});

test('priority migration preserves existing decisions and timestamps, defaults old requests to Normal and is replay-safe', async () => {
  const db = new PGlite();
  try {
    await db.exec(`CREATE TABLE app_schema_migrations(version text PRIMARY KEY);
      CREATE TABLE seek_permissions(id int PRIMARY KEY,status text,updated_at timestamptz);
      INSERT INTO seek_permissions VALUES(1,'approved','2026-10-01T12:00:00Z');`);
    const query = async (sql, values) => values?.length ? db.query(sql, values) : (await db.exec(sql)).at(-1);
    const database = { connect: async () => ({ query, release() {} }) };
    assert.equal(await migratePriority(database), true);
    assert.equal(await migratePriority(database), false);
    const row = (await db.query('SELECT * FROM seek_permissions WHERE id=1')).rows[0];
    assert.equal(row.priority,'normal'); assert.equal(row.status,'approved');
    assert.equal(new Date(row.updated_at).toISOString(),'2026-10-01T12:00:00.000Z');
    await assert.rejects(db.query("UPDATE seek_permissions SET priority='urgent' WHERE id=1"), error => error.code === '23514');
    await assert.rejects(db.query('UPDATE seek_permissions SET priority=NULL WHERE id=1'), error => error.code === '23502');
  } finally { await db.close(); }
});
