import assert from 'node:assert/strict';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import permissionModel from '../src/models/Permission.model.js';
import { listModuleVisibility, setModuleVisibility } from '../src/services/moduleVisibility.service.js';
import { canUserViewEntry, resolveEntryVisibility } from '../src/services/entryVisibility.service.js';

test('Expense management and the permission matrix share creator visibility without changing write or approval rights', async () => {
  const db = new PGlite();
  const original = permissionModel.getPermission;
  const admin = { id: 1, role: 'admin', organization_id: 1 };
  const staff = { id: 2, role: 'sub_admin', organization_id: 1 };
  try {
    await db.exec(`CREATE TABLE users(id int PRIMARY KEY,name text,role text,organization_id int,is_active boolean);
      INSERT INTO users VALUES(1,'Admin','admin',1,true),(2,'Selected','sub_admin',1,true),
        (3,'Not selected','sub_admin',1,true),(4,'Other organization','sub_admin',2,true),(5,'Inactive','sub_admin',1,false);
      CREATE TABLE user_permissions(user_id int,module text,can_read boolean,can_write boolean,can_update boolean,
        can_delete boolean,can_restore boolean,can_view_all boolean,updated_at timestamptz,UNIQUE(user_id,module));
      INSERT INTO user_permissions VALUES(2,'expenses',true,false,false,false,false,false,now()),
        (2,'expense_approval',false,false,false,false,false,false,now());`);
    permissionModel.getPermission = async (id, module) => (await db.query('SELECT * FROM user_permissions WHERE user_id=$1 AND module=$2', [id, module])).rows[0];
    assert.equal(await canUserViewEntry(staff, 'expenses', 3), false);
    await setModuleVisibility(admin, 'expenses', 2, true, db);
    assert.equal(await canUserViewEntry(staff, 'expenses', 3), true);
    assert.deepEqual(await resolveEntryVisibility(staff, 'expenses', 3), { canViewAll: true, creatorId: 3 });
    assert.equal(await canUserViewEntry({ ...staff, id: 3 }, 'expenses', 2), false);
    const permissions = await permissionModel.getPermission(2, 'expenses');
    for (const field of ['can_write', 'can_update', 'can_delete', 'can_restore']) assert.equal(permissions[field], false);
    assert.equal((await permissionModel.getPermission(2, 'expense_approval')).can_read, false);
    const users = await listModuleVisibility(admin, 'expenses', db);
    assert.deepEqual(users.map(user => user.id), [1, 3, 2]);
    assert.equal(users.find(user => user.id === 1).admin_access, true);
    assert.equal(users.find(user => user.id === 2).view_all, true);
    await setModuleVisibility(admin, 'expenses', 2, false, db);
    assert.equal(await canUserViewEntry(staff, 'expenses', 3), false);
    assert.equal(await canUserViewEntry(staff, 'expenses', 2), true);
    assert.deepEqual(await resolveEntryVisibility(staff, 'expenses', '3,4'), { canViewAll: false, creatorId: 2 });
    await permissionModel.upsert(2, 'expenses', { ...permissions, can_view_all: true }, db);
    assert.equal((await listModuleVisibility(admin, 'expenses', db)).find(user => user.id === 2).view_all, true, 'matrix edits are reflected by Settings');
    for (const id of [1, 4, 5, 999]) await assert.rejects(setModuleVisibility(admin, 'expenses', id, true, db), error => error.statusCode === 404);
    await assert.rejects(setModuleVisibility(staff, 'expenses', 2, true, db), error => error.statusCode === 403);
    await assert.rejects(setModuleVisibility(admin, 'expense_approval', 2, true, db), error => error.statusCode === 400);
    await assert.rejects(setModuleVisibility(admin, 'expenses', 2, 'true', db), error => error.statusCode === 400);
    await assert.rejects(setModuleVisibility(admin, 'expenses', '2x', true, db), error => error.statusCode === 400);
  } finally { permissionModel.getPermission = original; await db.close(); }
});
