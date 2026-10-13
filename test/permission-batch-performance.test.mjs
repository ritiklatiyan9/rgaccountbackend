import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import permissionModel from '../src/models/Permission.model.js';

test('permission batches use one normal read and preserve existing and missing grant semantics', async () => {
  const db = new PGlite();
  try {
    await db.exec(`CREATE TABLE user_permissions(user_id int, module text, can_read boolean,
      can_write boolean, can_update boolean, can_delete boolean, can_restore boolean, can_view_all boolean,
      updated_at timestamp DEFAULT NOW(), UNIQUE(user_id,module));
      INSERT INTO user_permissions(user_id,module,can_read,can_write,can_view_all)
        VALUES(1,'clients',false,false,false),(1,'vendors',true,true,true),(2,'clients',true,true,true);`);
    let calls = 0;
    const measured = { query: (...args) => { calls++; return db.query(...args); } };
    const grants = await permissionModel.getPermissions(1, ['clients', 'vendors', 'clients'], measured);
    assert.equal(calls, 1);
    assert.equal(grants.size, 2);
    assert.equal(grants.get('clients').can_read, false);
    assert.equal(grants.get('vendors').can_view_all, true);
    calls = 0;
    const seeded = await permissionModel.getPermissions(1, ['clients', 'farmers', 'tds', 'unknown'], measured);
    assert.equal(calls, 3, 'missing known defaults are seeded as one batch then current grants are re-read');
    assert.equal(seeded.get('clients').can_read, false, 'explicit denial stays denied');
    assert.equal(seeded.get('farmers').can_read, true, 'legacy default matches getPermission');
    assert.equal(seeded.get('farmers').can_view_all, false);
    assert.equal(seeded.get('tds').can_read, false, 'restricted defaults stay fail-closed');
    assert.equal(seeded.has('unknown'), false);
    const other = await permissionModel.getPermissions(2, ['clients'], measured);
    assert.equal(other.get('clients').can_read, true, 'grants remain scoped by user');
    const before = calls;
    assert.equal((await permissionModel.getPermissions(1, [], measured)).size, 0);
    assert.equal(calls, before);
  } finally { await db.close(); }
});

test('a concurrently inserted explicit permission wins over missing-module defaults', async () => {
  const db = new PGlite();
  try {
    await db.exec(`CREATE TABLE user_permissions(user_id int, module text, can_read boolean,
      can_write boolean, can_update boolean, can_delete boolean, can_restore boolean, can_view_all boolean,
      UNIQUE(user_id,module));`);
    let raced = false;
    const racing = { query: async (sql, values) => {
      if (sql.includes('INSERT INTO') && !raced) {
        raced = true;
        await db.exec("INSERT INTO user_permissions VALUES (1,'farmers',false,false,false,false,false,false)");
      }
      return db.query(sql, values);
    } };
    const grants = await permissionModel.getPermissions(1, ['farmers'], racing);
    assert.equal(grants.get('farmers').can_read, false);
    assert.equal(grants.get('farmers').can_view_all, false);
  } finally { await db.close(); }
});
