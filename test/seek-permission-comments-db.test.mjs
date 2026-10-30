import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { migrationSql as requestsSql } from '../src/migrations/222_seek_permissions.js';
import { migrationSql as targetsSql } from '../src/migrations/223_seek_permission_targets.js';
import { migrationSql as commentsSql } from '../src/migrations/230_seek_permission_comments.js';
import { migrationSql as prioritySql } from '../src/migrations/231_seek_permission_priority.js';
import {
  createSeekPermission, createSeekComment, decideSeekPermission, getSeekPermission, listSeekComments,
  listSeekPermissions, markSeekCommentsSeen, markSeekSeen, seekInbox, seekRecipients, setSeekAccess,
} from '../src/services/seekPermission.service.js';

const admin = { id: 1, role: 'admin', organization_id: 1 };
const ravi = { id: 5, role: 'sub_admin', organization_id: 1 };
const sunny = { id: 6, role: 'sub_admin', organization_id: 1 };
const observer = { id: 10, role: 'sub_admin', organization_id: 1 };
const outsider = { id: 7, role: 'sub_admin', organization_id: 1 };
const foreignAdmin = { id: 9, role: 'admin', organization_id: 2 };
const superAdmin = { id: 11, role: 'super_admin', organization_id: 1 };
const rejects = (promise, code) => assert.rejects(promise, error => error.statusCode === code);
const say = (db, actor, request, body, client_id = randomUUID()) => createSeekComment(actor, request.id, { body, client_id }, db);
const ask = (db, body = {}) => createSeekPermission(ravi, { site_id: 1, asked_to: 6, title: 'Site advance', ...body }, db);

async function fixture() {
  const db = new PGlite();
  await db.exec(`CREATE TABLE sites(id int PRIMARY KEY, name text, organization_id int);
    CREATE TABLE users(id int PRIMARY KEY, name text, role text, organization_id int, is_active boolean);
    CREATE TABLE user_sites(user_id int, site_id int);
    INSERT INTO sites VALUES (1, 'Green River', 1), (2, 'Mount Valley', 1), (3, 'Foreign site', 2);
    INSERT INTO users VALUES (1, 'Admin', 'admin', 1, true), (5, 'Ravi', 'sub_admin', 1, true),
      (6, 'Sunny', 'sub_admin', 1, true), (7, 'Other site', 'sub_admin', 1, true),
      (9, 'Foreign admin', 'admin', 2, true), (10, 'Observer', 'sub_admin', 1, true),
      (11, 'Super admin', 'super_admin', 1, true), (12, 'Employee', 'employee', 1, true);
    INSERT INTO user_sites VALUES (5, 1), (5, 2), (6, 1), (7, 2), (10, 1), (12, 1);
    ${requestsSql} ${targetsSql} ${commentsSql} ${prioritySql}`);
  return db;
}

test('comments enforce current site, organization, role and Studio visibility; observers cannot decide', async () => {
  const db = await fixture();
  try {
    const request = await ask(db);
    assert.deepEqual((await seekRecipients(request, db)).sort((a, b) => a - b), [1, 5, 6, 11]);
    for (const actor of [observer, outsider, foreignAdmin]) {
      await rejects(listSeekComments(actor, request.id, {}, db), 404);
      await rejects(say(db, actor, request, 'No access'), 404);
      await rejects(markSeekCommentsSeen(actor, request.id, { last_comment_id: 0 }, db), 404);
    }
    await rejects(say(db, { id: 12, role: 'employee', organization_id: 1 }, request, 'No'), 403);
    await setSeekAccess(admin, observer.id, { site_id: 1, scope: 'selected', user_ids: [ravi.id] }, db);
    assert.equal((await getSeekPermission(observer, request.id, db)).can_decide, false);
    assert.equal((await seekInbox(observer, { site_id: 1 }, db)).received[0].can_decide, false);
    await rejects(decideSeekPermission(observer, request.id, 'approve', '', db), 403);
    const message = await say(db, observer, request, 'Please confirm the quotation.');
    assert.equal(message.comment.author_name, 'Observer');
    await say(db, superAdmin, request, 'Reviewed.');
    await setSeekAccess(admin, observer.id, { site_id: 1, scope: 'own' }, db);
    await rejects(say(db, observer, request, 'Retry', message.comment.client_id), 404);
    await rejects(listSeekComments(observer, request.id, {}, db), 404);
    assert.ok(!(await seekRecipients(request, db)).includes(observer.id));
    await setSeekAccess(admin, observer.id, { site_id: 1, scope: 'all' }, db);
    await db.exec('DELETE FROM user_sites WHERE user_id = 10 AND site_id = 1');
    await rejects(listSeekComments(observer, request.id, {}, db), 404);
    assert.ok(!(await seekRecipients(request, db)).includes(observer.id), 'stale Studio grant is not a socket recipient');
    await db.exec('DELETE FROM user_sites WHERE user_id = 6 AND site_id = 1');
    await rejects(say(db, sunny, request, 'Former assignee'), 404);
    assert.ok(!(await seekRecipients(request, db)).includes(sunny.id), 'former assignee is not a socket recipient');
    await db.exec('UPDATE users SET is_active = false WHERE id = 1');
    await rejects(say(db, admin, request, 'Inactive admin'), 404);
    assert.ok(!(await seekRecipients(request, db)).includes(admin.id));
    await db.exec("UPDATE users SET role = 'employee' WHERE id = 11");
    await rejects(say(db, superAdmin, request, 'Old role'), 404);
  } finally { await db.close(); }
});

test('thread replies are paged by id and retries are idempotent without resetting unread replies', async () => {
  const db = await fixture();
  try {
    const request = await ask(db);
    const firstId = randomUUID();
    const empty = await listSeekComments(admin, request.id, { after_id: 0 }, db);
    assert.deepEqual(empty.comments, []);
    assert.equal(empty.has_more, false);
    const [first, replay] = await Promise.all([
      say(db, ravi, request, '  Line one\r\nLine two  ', firstId),
      say(db, ravi, request, 'Line one\nLine two', firstId),
    ]);
    assert.equal(first.comment.id, replay.comment.id);
    assert.equal([first.created, replay.created].filter(Boolean).length, 1);
    await rejects(say(db, ravi, request, 'Different reply', firstId), 409);
    const all = [first.comment];
    for (let index = 0; index < 6; index++) all.push((await say(db, index % 2 ? sunny : ravi, request, `Message ${index}`)).comment);
    const latest = await listSeekComments(admin, request.id, { limit: 3 }, db);
    assert.deepEqual(latest.comments.map(c => c.id), all.slice(-3).map(c => c.id));
    assert.equal(latest.has_more, true);
    assert.equal(latest.comment_count, 7);
    assert.equal(latest.unread_comments, 7);
    const older = await listSeekComments(admin, request.id, { before_id: latest.next_before_id, limit: 3 }, db);
    assert.deepEqual(older.comments.map(c => c.id), all.slice(1, 4).map(c => c.id));
    const delta = await listSeekComments(admin, request.id, { after_id: all[0].id, limit: 3 }, db);
    assert.deepEqual(delta.comments.map(c => c.id), all.slice(1, 4).map(c => c.id));
    assert.equal(delta.has_more, true);
    const tail = await listSeekComments(admin, request.id, { after_id: delta.last_comment_id }, db);
    assert.deepEqual(tail.comments.map(c => c.id), all.slice(4).map(c => c.id));
    assert.equal(tail.has_more, false);
    assert.deepEqual((await listSeekComments(admin, request.id, { after_id: '0', limit: 100 }, db)).comments.map(c => c.id), all.map(c => c.id));
    await rejects(listSeekComments(admin, request.id, { before_id: 1, after_id: 2 }, db), 400);
    for (const bad of [{ limit: 101 }, { limit: 0 }, { before_id: 0 }, { before_id: '-1' }, { after_id: '1 OR 1=1' }]) {
      await rejects(listSeekComments(admin, request.id, bad, db), 400);
    }
    for (const body of ['', 'x'.repeat(4001), {}, 'NUL\0text']) await rejects(say(db, ravi, request, body), 400);
    await rejects(say(db, ravi, request, 'Text', 'invalid'), 400);
    await rejects(listSeekComments(admin, '1.5', {}, db), 400);
    assert.equal((await getSeekPermission(ravi, request.id, db)).unread_comments, 3, 'own messages never count as unread');
    assert.equal((await getSeekPermission(admin, request.id, db)).comment_count, 7, 'replays never increment counters');
  } finally { await db.close(); }
});

test('read watermarks are bounded, monotonic and leave concurrent/new replies unread; decided threads stay in bell', async () => {
  const db = await fixture();
  try {
    const request = await ask(db);
    const other = await ask(db, { site_id: 2, asked_to: 1 });
    const old = await say(db, ravi, request, 'Original reply');
    const foreignThread = await say(db, ravi, other, 'Another site');
    await rejects(markSeekCommentsSeen(admin, request.id, { last_comment_id: 999999 }, db), 400);
    await rejects(markSeekCommentsSeen(admin, request.id, { last_comment_id: foreignThread.comment.id }, db), 400);
    assert.equal((await markSeekCommentsSeen(admin, request.id, { last_comment_id: 0 }, db)).unread_comments, 1);
    await Promise.all([
      markSeekCommentsSeen(admin, request.id, { last_comment_id: old.comment.id }, db),
      say(db, sunny, request, 'Arrived during read'),
    ]);
    let details = await getSeekPermission(admin, request.id, db);
    assert.equal(details.unread_comments, 1);
    const newest = (await listSeekComments(admin, request.id, {}, db)).comments.at(-1);
    await markSeekCommentsSeen(admin, request.id, { last_comment_id: newest.id }, db);
    await markSeekCommentsSeen(admin, request.id, { last_comment_id: old.comment.id }, db);
    details = await getSeekPermission(admin, request.id, db);
    assert.equal(details.unread_comments, 0, 'a slow earlier read never moves the cursor backwards');
    await decideSeekPermission(admin, request.id, 'approve', '', db);
    await say(db, sunny, request, 'Follow-up after approval');
    let inbox = await seekInbox(admin, { site_id: 1 }, db);
    assert.equal(inbox.received_count, 1);
    assert.equal(inbox.received[0].status, 'approved');
    assert.equal(inbox.received[0].can_decide, false);
    assert.equal(inbox.unread_comments_count, 1);
    await markSeekSeen(ravi, { site_id: 1 }, db);
    inbox = await seekInbox(ravi, { site_id: 1 }, db);
    assert.equal(inbox.sent_unseen_count, 0);
    assert.equal(inbox.sent_unread_count, 1, 'unread conversation count is threads, not messages');
    assert.equal(inbox.sent_attention_count, 1, 'a reply to an already-seen approved own request still needs attention');
    assert.equal(inbox.sent[0].unread_comments, 2, 'opening the bell does not mark conversation replies read');
    const last = (await listSeekComments(admin, request.id, {}, db)).comments.at(-1);
    await markSeekCommentsSeen(admin, request.id, { last_comment_id: last.id }, db);
    assert.equal((await seekInbox(admin, { site_id: 1 }, db)).received_count, 0);
    assert.equal((await seekInbox(admin, { site_id: 2 }, db)).unread_comments_count, 1, 'reading one site leaves another alone');
  } finally { await db.close(); }
});

test('inbox totals are uncapped and lists load metadata as a batch without message bodies', async () => {
  const db = await fixture();
  try {
    await db.exec(`INSERT INTO seek_permissions (site_id, requested_by, asked_to, title)
      SELECT 1, 5, 6, 'Request ' || n FROM generate_series(1, 220) n;`);
    const adminInbox = await seekInbox(admin, { site_id: 1 }, db);
    assert.equal(adminInbox.received.length, 200);
    assert.equal(adminInbox.received_count, 220);
    const own = await seekInbox(ravi, { site_id: 1 }, db);
    assert.equal(own.sent.length, 50);
    assert.equal(own.sent_pending_count, 220);
    let calls = 0;
    const countingDb = { query: (...args) => { calls++; return db.query(...args); } };
    const rows = await listSeekPermissions(admin, { site_id: 1 }, countingDb);
    assert.equal(calls, 1);
    assert.equal(rows.length, 220);
    assert.equal(rows[0].comment_count, 0);
    assert.equal(rows[0].unread_comments, 0);
    assert.equal(rows[0].can_decide, true);
    assert.ok(!Object.hasOwn(rows[0], 'body'));
    calls = 0;
    await listSeekComments(admin, rows[0].id, {}, countingDb);
    assert.equal(calls, 1, 'comment page, authorization and metadata share one SQL snapshot');
    await db.exec("UPDATE users SET role = 'admin' WHERE id = 5");
    const promoted = await seekInbox({ ...ravi, role: 'admin' }, { site_id: 1 }, db);
    assert.equal(promoted.sent_pending_count, 220, 'promoted requesters retain navigable sent requests');
  } finally { await db.close(); }
});
