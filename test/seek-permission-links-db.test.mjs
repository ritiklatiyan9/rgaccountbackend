import assert from 'node:assert/strict';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { migrationSql as requestsSql } from '../src/migrations/222_seek_permissions.js';
import { migrationSql as targetsSql } from '../src/migrations/223_seek_permission_targets.js';
import { migrationSql as commentsSql } from '../src/migrations/230_seek_permission_comments.js';
import { migrationSql as prioritySql } from '../src/migrations/231_seek_permission_priority.js';
import { migrationSql as linksSql, up as migrateLinks } from '../src/migrations/248_seek_permission_links.js';
import {
  cancelSeekPermission, createSeekPermission, decideSeekPermission, listSeekLinks, SEEK_LINK_TARGETS, setSeekAccess, setSeekLink,
} from '../src/services/seekPermission.service.js';

const admin = { id: 1, role: 'admin', organization_id: 1 }; // Kuldeep
const aman = { id: 5, role: 'sub_admin', organization_id: 1 }; // makes the entries, asks permission
const ravi = { id: 6, role: 'sub_admin', organization_id: 1 }; // reviewer of Aman's entries
const sunny = { id: 7, role: 'sub_admin', organization_id: 1 }; // on the site, unrelated
const outsider = { id: 8, role: 'sub_admin', organization_id: 1 }; // site 2 only
const foreignAdmin = { id: 9, role: 'admin', organization_id: 2 };
const rejects = (promise, statusCode, message = /./, note) =>
  assert.rejects(promise, error => error.statusCode === statusCode && message.test(error.message), note);

test('seek links: who may attach what, to which entry, and who sees it', async () => {
  const db = new PGlite();
  try {
    await db.exec(`CREATE TABLE sites(id int PRIMARY KEY, name text, organization_id int);
      CREATE TABLE users(id int PRIMARY KEY, name text, role text, organization_id int, is_active boolean);
      CREATE TABLE user_sites(user_id int, site_id int);
      INSERT INTO sites VALUES (1, 'Green River', 1), (2, 'Mount Valley', 1), (3, 'Foreign site', 2);
      INSERT INTO users VALUES (1, 'Kuldeep', 'admin', 1, true), (5, 'Aman', 'sub_admin', 1, true),
        (6, 'Ravi', 'sub_admin', 1, true), (7, 'Sunny', 'sub_admin', 1, true), (8, 'Outsider', 'sub_admin', 1, true),
        (9, 'Foreign admin', 'admin', 2, true), (12, 'Employee', 'employee', 1, true);
      INSERT INTO user_sites VALUES (5, 1), (5, 2), (6, 1), (7, 1), (8, 2), (12, 1);
      ${requestsSql} ${targetsSql} ${commentsSql} ${prioritySql} ${linksSql}
      CREATE TABLE expenses(id int PRIMARY KEY, site_id int, created_by int, assigned_admin_id int, status text);
      INSERT INTO expenses VALUES (1, 1, 5, 6, 'pending'), (2, 1, 5, 6, 'approved'), (3, 1, 8, 1, 'pending'), (4, 3, 9, 9, 'pending');
      CREATE TABLE farmers(id int PRIMARY KEY, site_id int);
      CREATE TABLE farmer_payments(id int PRIMARY KEY, farmer_id int, created_by int, assigned_admin_id int, status text);
      INSERT INTO farmers VALUES (1, 1); INSERT INTO farmer_payments VALUES (1, 1, 5, 6, 'pending');
      CREATE TABLE edit_requests(id int PRIMARY KEY, site_id int, original_data jsonb, requested_by int, status text);
      INSERT INTO edit_requests VALUES (1, NULL, '{"site_id": "1"}', 5, 'pending');
      CREATE TABLE imprest_expense_requests(id int PRIMARY KEY, site_id int, sub_admin_id int, assigned_admin_id int, status text);
      INSERT INTO imprest_expense_requests VALUES (1, 1, 5, 1, 'PENDING');`);
    const ask = body => createSeekPermission(aman, { site_id: 1, asked_to: 1, ...body }, db);
    const steel = await decideSeekPermission(admin, (await ask({ title: 'Steel work', amount: 50000 })).id, 'approve', 'Go ahead', db);
    const cement = await ask({ title: 'Cement' });
    const shuttering = await decideSeekPermission(ravi, (await ask({ title: 'Shuttering', asked_to: 6 })).id, 'approve', '', db);
    const rejected = await decideSeekPermission(admin, (await ask({ title: 'Diesel' })).id, 'reject', '', db);
    const withdrawn = await cancelSeekPermission(aman, (await ask({ title: 'JCB' })).id, db);
    const otherSite = await decideSeekPermission(admin, (await ask({ site_id: 2, title: 'Bricks' })).id, 'approve', '', db);
    const attach = (actor, target, id, seekId, site_id = 1) => setSeekLink(actor, target, id, { site_id, seek_permission_id: seekId }, db);
    const look = (actor, targets, site_id = 1) => listSeekLinks(actor, { site_id, targets }, db);
    const keys = links => links.map(l => `${l.target}:${l.target_id}:${l.seek_permission_id}`);

    // The maker attaches their own approved request to the pending ₹10 lakh expense.
    const { link: firstLink, ...firstWrite } = await attach(aman, 'expense', 1, steel.id);
    assert.deepEqual(firstWrite, { site_id: 1, seek_permission_id: steel.id, previous_seek_permission_id: null });
    const { request, linked_at, ...link } = firstLink;
    assert.deepEqual(link, { target: 'expense', target_id: 1, site_id: 1, seek_permission_id: steel.id,
      linked_by: 5, linked_by_name: 'Aman', link_count: 1 });
    assert.ok(linked_at);
    assert.equal(request.status, 'approved'); assert.equal(request.decided_by_name, 'Kuldeep');
    assert.equal(request.title, 'Steel work'); assert.equal(Number(request.amount), 50000);
    assert.deepEqual(request.attachments, []); assert.ok(!Object.hasOwn(request, 'last_read_comment_id'));

    // Read: deduped, per site, only when the viewer may see the request (the page's own rule).
    assert.deepEqual(keys(await look(admin, ' expense:1,expense:1,expense:2, daybook:9,')), [`expense:1:${steel.id}`]);
    assert.deepEqual(await look(sunny, 'expense:1'), [], 'not his request, not asked of him');
    await setSeekAccess(admin, sunny.id, { site_id: 1, scope: 'all' }, db);
    assert.deepEqual(keys(await look(sunny, 'expense:1')), [`expense:1:${steel.id}`], 'a Studio grant shows it');
    await setSeekAccess(admin, sunny.id, { site_id: 1, scope: 'own' }, db);
    assert.deepEqual(await look(admin, 'expense:1', 2), []);
    assert.deepEqual(await look(foreignAdmin, 'expense:1'), []);
    for (const targets of [undefined, '', ' , ']) assert.deepEqual(await look(aman, targets), []);

    // Who may act: the maker or reviewer while on the site, any admin of the organisation.
    await rejects(attach(sunny, 'expense', 1, steel.id), 403, /Only the person who made this entry/);
    await rejects(attach(outsider, 'expense', 3, steel.id), 403, /Only the person/, 'made it, but no longer on the site');
    await rejects(attach(outsider, 'expense', 1, steel.id, 2), 404, /Entry not found on this site/);
    await rejects(attach(foreignAdmin, 'expense', 1, steel.id), 404, /Entry not found/);
    await rejects(attach(foreignAdmin, 'expense', 4, steel.id, 3), 404, /Permission request not found/);
    await rejects(attach({ id: 12, role: 'employee', organization_id: 1 }, 'expense', 1, steel.id), 403);
    await rejects(look({ id: 12, role: 'employee', organization_id: 1 }, 'expense:1'), 403);

    // Reviewer attaches a request asked of him; farmer payments take the site from the farmer.
    const reviewed = await attach(ravi, 'farmer_payment', 1, shuttering.id);
    assert.equal(reviewed.link.site_id, 1); assert.equal(reviewed.link.linked_by_name, 'Ravi');
    await rejects(attach(ravi, 'farmer_payment', 1, shuttering.id, 2), 404, /Entry not found/);
    await rejects(attach(ravi, 'expense', 1, steel.id), 404, /Permission request not found/, 'a request he cannot see');

    // Which request: same site, visible, approved or still pending. Imprest statuses are upper-case.
    await rejects(attach(aman, 'imprest_request', 1, otherSite.id), 404, /Permission request not found/);
    await rejects(attach(aman, 'imprest_request', 1, rejected.id), 409, /can't be attached/);
    await rejects(attach(aman, 'imprest_request', 1, withdrawn.id), 409, /can't be attached/);
    assert.equal((await attach(aman, 'imprest_request', 1, cement.id)).link.request.status, 'pending');

    // Edit requests without a site column take it from the original record.
    assert.equal((await attach(aman, 'edit_request', 1, steel.id)).link.site_id, 1);
    await rejects(attach(aman, 'edit_request', 1, steel.id, 2), 404);
    await rejects(attach(ravi, 'edit_request', 1, shuttering.id), 403, /Only the person/, 'edit requests have no reviewer');

    // Decided entries: only an admin may still change them.
    await rejects(attach(aman, 'expense', 2, steel.id), 409, /already decided/);
    assert.equal((await attach(admin, 'expense', 2, steel.id)).link.link_count, 3, 'expense 1 + 2 + edit request 1');
    assert.deepEqual((await look(admin, 'expense:1,expense:2')).map(l => l.link_count), [3, 3]);

    // Only whoever attached it, or an admin, may replace or remove a link.
    await rejects(attach(ravi, 'expense', 1, shuttering.id), 409, /^Already attached by Aman\. Only they or an admin can change it\.$/);
    const replaced = await attach(admin, 'expense', 1, cement.id);
    assert.equal(replaced.previous_seek_permission_id, steel.id);
    assert.equal(replaced.link.linked_by_name, 'Kuldeep'); assert.equal(replaced.link.seek_permission_id, cement.id);
    assert.equal((await look(admin, 'expense:2'))[0].link_count, 2);
    await rejects(attach(aman, 'expense', 1, null), 409, /Already attached by Kuldeep/);

    // Remove: the linker may; removing again is a harmless no-op.
    assert.deepEqual(await attach(ravi, 'farmer_payment', 1, null),
      { link: null, site_id: 1, seek_permission_id: null, previous_seek_permission_id: shuttering.id });
    assert.deepEqual(await attach(ravi, 'farmer_payment', 1, null),
      { link: null, site_id: 1, seek_permission_id: null, previous_seek_permission_id: null });

    // Input: registry targets only, positive ids, an explicit request id or null.
    for (const target of ['kyc', 'constructor', '__proto__', 'toString', 'EXPENSE', '']) await rejects(attach(admin, target, 1, steel.id), 400);
    for (const targets of ['kyc:1', 'constructor:1', 'expense:0', 'expense:-1', 'expense:1.5', 'expense', 'expense:1:2', 'expense:x']) {
      await rejects(look(admin, targets), 400);
    }
    for (const body of [{ site_id: 1 }, { seek_permission_id: steel.id }, { site_id: 1, seek_permission_id: '0' }, { site_id: 'x', seek_permission_id: null }]) {
      await rejects(setSeekLink(admin, 'expense', 1, body, db), 400);
    }
    await rejects(attach(admin, 'expense', '1 OR 1=1', steel.id), 400);
    const many = count => Array.from({ length: count }, (_, index) => `expense:${index + 1}`).join(',');
    await rejects(look(admin, many(201)), 400);
    assert.equal((await look(admin, `${many(200)},expense:1`)).length, 2, '200 distinct entries are fine');

    // A module whose table is not installed has no such entry: 404, never 500.
    await rejects(attach(admin, 'daybook', 1, steel.id), 404, /Entry not found/);

    // Deleting a request removes its links.
    await db.query('DELETE FROM seek_permissions WHERE id = $1', [steel.id]);
    assert.deepEqual(keys(await look(admin, 'expense:1,expense:2,edit_request:1')), [`expense:1:${cement.id}`]);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM seek_permission_links WHERE seek_permission_id = $1', [steel.id])).rows[0].n, 0);
  } finally { await db.close(); }
});

test('link targets match the frontend contract and the migration is replay-safe', async () => {
  assert.deepEqual(Object.keys(SEEK_LINK_TARGETS).sort(), ['cash_flow_entry', 'daybook', 'edit_request', 'expense', 'farmer_payment',
    'firm_transaction', 'imprest_request', 'land_deal_payment', 'misc_income_entry', 'plot_commission', 'plot_commission_payment',
    'plot_installment_payment', 'plot_payment', 'plot_registry_payment', 'plot_status', 'transaction_transfer', 'vendor_inventory_payment',
    'vendor_payment']);
  const db = new PGlite();
  try {
    await db.exec(`CREATE TABLE app_schema_migrations(version text PRIMARY KEY); CREATE TABLE sites(id int PRIMARY KEY);
      CREATE TABLE users(id int PRIMARY KEY); CREATE TABLE seek_permissions(id int PRIMARY KEY);`);
    const query = async (sql, values) => values?.length ? db.query(sql, values) : (await db.exec(sql)).at(-1);
    const database = { connect: async () => ({ query, release() {} }) };
    assert.equal(await migrateLinks(database), true);
    assert.equal(await migrateLinks(database), false);
    await assert.rejects(db.query("INSERT INTO seek_permission_links(target,target_id,site_id,seek_permission_id,linked_by) VALUES ('Bad-Target',1,1,1,1)"),
      error => error.code === '23514');
  } finally { await db.close(); }
});
