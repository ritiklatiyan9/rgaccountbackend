import assert from 'node:assert/strict';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { migrationSql } from '../src/migrations/250_complaints.js';
import { migrationSql as conversationsSql } from '../src/migrations/251_complaint_conversations.js';
import {
  changeComplaintStatus, complaintAttachmentUrl, complaintInbox, complaintRecipients, createComplaint, createComplaintComment,
  listComplaintAccess, listComplaintComments, listComplaintEvents, listComplaintPeople, listComplaints, markComplaintCommentsSeen,
  reassignComplaint, setComplaintAccess, shareComplaint,
} from '../src/services/complaint.service.js';

test('Complaints: raise about a person/module, assign, work it through, Studio controls who follows what', async () => {
  const db = new PGlite();
  const admin = { id: 1, role: 'admin', organization_id: 1 };
  const ravi = { id: 5, role: 'sub_admin', organization_id: 1 };
  const sunny = { id: 6, role: 'sub_admin', organization_id: 1 };
  const outsider = { id: 7, role: 'sub_admin', organization_id: 1 }; // not on site 1
  const meena = { id: 10, role: 'sub_admin', organization_id: 1 };
  const foreignAdmin = { id: 9, role: 'admin', organization_id: 2 };
  const rejects = (promise, statusCode) => assert.rejects(promise, error => error.statusCode === statusCode);
  const pdf = { path: '/tmp/x', filename: 'c.pdf', originalname: 'proof.pdf', mimetype: 'application/pdf', size: 99 };
  let uploads = 0;
  const store = async files => { uploads += files.length; return files.map(f => ({ url: `https://b.s3.ap-south-1.amazonaws.com/vouchers/${f.filename}`, name: f.originalname, type: f.mimetype, size: f.size })); };
  const raise = (actor, body, files = []) => createComplaint(actor, { site_id: 1, assigned_to: 1, title: 'x', ...body }, db, files, store);
  const ids = rows => rows.map(row => row.id).sort();
  const complaintIds = rows => rows.map(row => row.id).sort((a, b) => a - b);
  try {
    await db.exec(`CREATE TABLE sites(id int PRIMARY KEY, name text, organization_id int);
      CREATE TABLE users(id int PRIMARY KEY, name text, role text, organization_id int, is_active boolean);
      CREATE TABLE user_sites(user_id int, site_id int);
      INSERT INTO sites VALUES (1, 'Green River', 1), (2, 'Mount Valley', 1);
      INSERT INTO users VALUES (1, 'Kuldeep', 'admin', 1, true), (5, 'Ravi', 'sub_admin', 1, true), (6, 'Sunny', 'sub_admin', 1, true),
        (7, 'Outsider', 'sub_admin', 1, true), (8, 'Gone', 'sub_admin', 1, false), (9, 'Other org', 'admin', 2, true), (10, 'Meena', 'sub_admin', 1, true);
      INSERT INTO user_sites VALUES (5, 1), (6, 1), (7, 2), (8, 1), (10, 1);
      ${migrationSql}
      -- a comment written before 251 moves into the discussion
      INSERT INTO complaints (id, site_id, raised_by, assigned_to, title) VALUES (900, 2, 5, 1, 'Legacy');
      INSERT INTO complaint_events (complaint_id, actor_id, kind, note) VALUES (900, 5, 'comment', 'old note');
      ${conversationsSql}`);
    assert.deepEqual((await db.query("SELECT body FROM complaint_comments WHERE complaint_id = 900")).rows, [{ body: 'old note' }]);
    assert.deepEqual((await db.query("SELECT comment_count FROM complaints WHERE id = 900")).rows, [{ comment_count: 1 }]);
    await db.exec('DELETE FROM complaints WHERE id = 900');

    // Pickers: anyone active in the org to complain about; only admins + site sub-admins are assignable.
    const people = await listComplaintPeople(ravi, { site_id: 1 }, db);
    assert.deepEqual(people.map(p => [p.name, p.assignable]), [['Kuldeep', true], ['Meena', true], ['Outsider', false], ['Sunny', true]]);
    assert.deepEqual(await listComplaintPeople(outsider, { site_id: 1 }, db), [], 'no pickers for a site you are not on');

    // Refusals happen before any upload.
    await rejects(raise(outsider, {}, [pdf]), 403);
    for (const assigned_to of [undefined, 7, 5, 8, 9]) await rejects(raise(ravi, { assigned_to }, [pdf]), 400);
    await rejects(raise(ravi, { title: '  ' }, [pdf]), 400);
    await rejects(raise(ravi, { priority: 'urgent' }, [pdf]), 400);
    await rejects(raise(ravi, { about_type: 'person', about_user_id: 6, assigned_to: 6 }, [pdf]), 400);
    await rejects(raise(ravi, { about_type: 'person', about_user_id: 5 }, [pdf]), 400); // not about yourself
    await rejects(raise(ravi, { about_type: 'module' }, [pdf]), 400);
    assert.equal(uploads, 0, 'a refused complaint never reaches S3');

    // Ravi complains about Sunny, assigned to Meena.
    const c1 = await raise(ravi, { title: ' Cash not deposited ', about_type: 'person', about_user_id: 6, assigned_to: 10, priority: 'critical' }, [pdf]);
    assert.equal(uploads, 1);
    assert.deepEqual([c1.title, c1.status, c1.about_user_name, c1.assigned_to_name, c1.priority], ['Cash not deposited', 'open', 'Sunny', 'Meena', 'critical']);
    assert.deepEqual(c1.attachments, [{ name: 'proof.pdf', type: 'application/pdf', size: 99 }], 'stored URL never leaves the server');
    assert.deepEqual(c1.statuses, ['closed'], 'raiser may only close');
    // Admin complains about the Day Book module, assigned to Ravi.
    const c2 = await createComplaint(admin, { site_id: 1, title: 'Day Book total wrong', about_type: 'module', about_module: 'Day Book', assigned_to: 5 }, db, [], store);

    // Visibility: admin all; raiser + assignee; Sunny (the accused) nothing; foreign org nothing.
    assert.deepEqual(ids(await listComplaints(admin, { site_id: 1 }, db)), [c1.id, c2.id]);
    assert.deepEqual(ids(await listComplaints(ravi, { site_id: 1 }, db)), [c1.id, c2.id]);
    assert.deepEqual(ids(await listComplaints(meena, { site_id: 1 }, db)), [c1.id]);
    assert.deepEqual(await listComplaints(sunny, { site_id: 1 }, db), []);
    assert.deepEqual(await listComplaints(foreignAdmin, { site_id: 1 }, db), []);
    await rejects(listComplaintEvents(sunny, c1.id, db), 404);

    // Studio: "everyone" lets Sunny follow the site, but never complaints about Sunny.
    await setComplaintAccess(admin, 6, { site_id: 1, scope: 'all' }, db);
    assert.deepEqual(ids(await listComplaints(sunny, { site_id: 1 }, db)), [c2.id]);
    await setComplaintAccess(admin, 6, { site_id: 1, scope: 'selected', user_ids: [10, 7, 6] }, db);
    assert.deepEqual((await listComplaintAccess(admin, { site_id: 1 }, db)).find(u => u.id === 6).user_ids, [10], 'only site sub-admins, never self');
    assert.deepEqual(await listComplaints(sunny, { site_id: 1 }, db), [], 'Meena\'s only complaint is about Sunny');
    await rejects(setComplaintAccess(ravi, 6, { site_id: 1, scope: 'all' }, db), 403);
    await rejects(setComplaintAccess(admin, 7, { site_id: 1, scope: 'all' }, db), 404);
    assert.deepEqual((await complaintRecipients(c1.id, db)).sort((a, b) => a - b), [1, 5, 10], 'socket goes only to who may see it');

    // Workflow: assignee starts, resolves with a note; raiser reopens; admin closes.
    await rejects(changeComplaintStatus(ravi, c1.id, { status: 'in_progress' }, db), 403);
    await rejects(changeComplaintStatus(meena, c1.id, { status: 'bogus' }, db), 400);
    let next = await changeComplaintStatus(meena, c1.id, { status: 'in_progress' }, db);
    assert.equal(next.status, 'in_progress');
    await rejects(changeComplaintStatus(meena, c1.id, { status: 'resolved' }, db), 400); // note required
    next = await changeComplaintStatus(meena, c1.id, { status: 'resolved', note: 'Deposited today' }, db);
    assert.ok(next.resolved_at);
    await rejects(changeComplaintStatus(meena, c1.id, { status: 'open', note: 'x' }, db), 403); // only raiser/admin reopen
    next = await changeComplaintStatus(ravi, c1.id, { status: 'open', note: 'Still short by 500' }, db);
    assert.equal(next.resolved_at, null);

    // Reassign: assignee or admin; never to the accused; races lose with 409.
    await rejects(reassignComplaint(ravi, c1.id, { assigned_to: 1 }, db), 403);
    await rejects(reassignComplaint(meena, c1.id, { assigned_to: 6 }, db), 400);
    await rejects(reassignComplaint(meena, c1.id, { assigned_to: 7 }, db), 400);
    next = await reassignComplaint(meena, c1.id, { assigned_to: 1, note: 'Needs admin' }, db);
    assert.equal(next.assigned_to_name, 'Kuldeep');
    assert.deepEqual(ids(await listComplaints(meena, { site_id: 1 }, db)), [], 'old assignee loses sight');

    // Discussion: Seek Permission's contract — idempotent per client_id, unread per viewer, watermark only moves forward.
    const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
    const first = await createComplaintComment(ravi, c1.id, { body: ' Bank slip attached ', client_id: uuid(1) }, db);
    assert.equal(first.created, true);
    assert.equal(first.comment.body, 'Bank slip attached');
    assert.equal((await createComplaintComment(ravi, c1.id, { body: 'Bank slip attached', client_id: uuid(1) }, db)).created, false, 'retry is a no-op');
    await rejects(createComplaintComment(ravi, c1.id, { body: 'different', client_id: uuid(1) }, db), 409);
    await rejects(createComplaintComment(ravi, c1.id, { body: '   ', client_id: uuid(2) }, db), 400);
    await rejects(createComplaintComment(ravi, c1.id, { body: 'x', client_id: 'nope' }, db), 400);
    await rejects(createComplaintComment(meena, c1.id, { body: 'hi', client_id: uuid(3) }, db), 404);
    const reply = await createComplaintComment(admin, c1.id, { body: 'Checking', client_id: uuid(4) }, db);
    const inboxAfterReply = await complaintInbox(ravi, { site_id: 1 }, db);
    assert.equal(Number(inboxAfterReply.sent.find(row => row.id === c1.id).latest_unread_comment_id), Number(reply.comment.id));
    let page = await listComplaintComments(ravi, c1.id, {}, db);
    assert.deepEqual(page.comments.map(c => c.body), ['Bank slip attached', 'Checking']);
    assert.deepEqual([page.comment_count, page.unread_comments], [2, 1], 'only the other person\'s reply is unread');
    assert.deepEqual((await listComplaintComments(ravi, c1.id, { after_id: first.comment.id }, db)).comments.map(c => c.body), ['Checking']);
    assert.deepEqual((await listComplaintComments(ravi, c1.id, { before_id: reply.comment.id, limit: 1 }, db)).comments.map(c => c.body), ['Bank slip attached']);
    await rejects(markComplaintCommentsSeen(ravi, c1.id, { last_comment_id: 999 }, db), 400);
    assert.equal((await markComplaintCommentsSeen(ravi, c1.id, { last_comment_id: reply.comment.id }, db)).unread_comments, 0);
    assert.equal((await markComplaintCommentsSeen(ravi, c1.id, { last_comment_id: first.comment.id }, db)).last_comment_id, reply.comment.id, 'never moves back');

    next = await changeComplaintStatus(admin, c1.id, { status: 'closed', note: 'Recovered' }, db);
    await rejects(changeComplaintStatus(admin, c1.id, { status: 'closed', note: 'again' }, db), 409);
    assert.equal(next.comment_count, 2);

    const { events } = await listComplaintEvents(ravi, c1.id, db);
    assert.deepEqual(events.map(e => [e.kind, e.status || e.assigned_to_name || e.note]),
      [['created', 'open'], ['status', 'in_progress'], ['status', 'resolved'], ['status', 'open'], ['assigned', 'Kuldeep'], ['status', 'closed']]);

    // Suggestions + "show to": chosen people see it, get it in their bell and can discuss; never the person it is about.
    await setComplaintAccess(admin, 6, { site_id: 1, scope: 'own' }, db);
    await rejects(raise(meena, { kind: 'idea' }), 400);
    await rejects(raise(meena, { about_type: 'person', about_user_id: 6, shared_with: [6] }), 400);
    await rejects(raise(meena, { shared_with: [7] }), 400); // not on this site
    const idea = await raise(meena, { kind: 'suggestion', title: 'Weekly cash audit', assigned_to: 1, shared_with: ['5', '10', '1'] });
    assert.equal(idea.kind, 'suggestion');
    assert.deepEqual(idea.shared_with, [5], 'self and assignee are dropped');
    assert.deepEqual(idea.shared_with_people, [{ id: 5, name: 'Ravi' }]);
    assert.ok((await listComplaints(ravi, { site_id: 1 }, db)).some(c => c.id === idea.id));
    assert.ok(!(await listComplaints(sunny, { site_id: 1 }, db)).some(c => c.id === idea.id));
    assert.ok((await complaintRecipients(idea.id, db)).includes(5));
    assert.deepEqual(complaintIds((await complaintInbox(ravi, { site_id: 1 }, db)).received), [c2.id, idea.id], 'assigned to him + shared with him');
    const asRavi = (await listComplaints(ravi, { site_id: 1 }, db)).find(c => c.id === idea.id);
    assert.deepEqual([asRavi.statuses, asRavi.can_reassign], [[], false], 'shared people discuss, they do not decide');
    await createComplaintComment(ravi, idea.id, { body: '+1', client_id: uuid(5) }, db);
    await rejects(shareComplaint(ravi, idea.id, { shared_with: [6] }, db), 403);
    const reshared = await shareComplaint(meena, idea.id, { shared_with: [6] }, db);
    assert.deepEqual(reshared.shared_with, [6]);
    assert.ok(!(await listComplaints(ravi, { site_id: 1 }, db)).some(c => c.id === idea.id), 'unshared → gone');
    assert.ok((await listComplaints(sunny, { site_id: 1 }, db)).some(c => c.id === idea.id));

    // Inbox: received = others' active (or unread) ones I can see; sent = mine.
    const inbox = await complaintInbox(meena, { site_id: 1 }, db);
    assert.deepEqual(complaintIds(inbox.sent), [idea.id]);
    assert.equal(inbox.sent_attention_count, 1, 'Ravi\'s +1 is unread for Meena');
    assert.equal(inbox.sent[0].unread_comments, 1);

    // Attachments: signed per click, only for viewers.
    const signed = await complaintAttachmentUrl(ravi, c1.id, 0, db, async url => `${url}?signed`);
    assert.match(signed.url, /vouchers\/c\.pdf\?signed$/);
    await rejects(complaintAttachmentUrl(sunny, c1.id, 0, db, async url => url), 404);
    await rejects(complaintAttachmentUrl(ravi, c1.id, 3, db, async url => url), 404);
  } finally {
    await db.close();
  }
});
