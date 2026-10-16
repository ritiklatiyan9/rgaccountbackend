import assert from 'node:assert/strict';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { canViewAllWallets, withWalletVisibility, listWalletVisibility, setWalletVisibility } from '../src/services/walletVisibility.service.js';
import { vaultTransactionScope } from '../src/services/loyaltyVaultTransactions.service.js';

test('wallet visibility persists per user, stays within the organization and can be revoked immediately', async () => {
  const db = new PGlite();
  const admin = { id: 1, role: 'admin', organization_id: 1 };
  const staff = { id: 2, role: 'sub_admin', organization_id: 1 };
  try {
    await db.exec(`CREATE TABLE users(id int PRIMARY KEY,name text,role text,organization_id int,is_active boolean);
      INSERT INTO users VALUES(1,'Admin','admin',1,true),(2,'Staff','sub_admin',1,true),
        (3,'Other organization','sub_admin',2,true),(4,'Inactive','sub_admin',1,false),(5,'Member','member',1,true);
      CREATE TABLE user_permissions(user_id int,module text,can_read boolean,can_write boolean,can_update boolean,
        can_delete boolean,can_restore boolean,can_view_all boolean,updated_at timestamptz,UNIQUE(user_id,module));
      INSERT INTO user_permissions VALUES(2,'expenses',true,true,true,false,false,true,now());`);
    assert.equal(canViewAllWallets(await withWalletVisibility(staff, db)), false);
    assert.equal(canViewAllWallets(await withWalletVisibility(admin, db)), true);
    let users = await listWalletVisibility(admin, db);
    assert.deepEqual(users.map(user => user.id), [1, 2]);
    assert.equal(users[0].view_all_wallets, true);
    assert.equal(users[0].admin_access, true);
    assert.equal(users[1].view_all_wallets, false);
    assert.deepEqual(await setWalletVisibility(admin, 2, true, db), { user_id: 2, view_all_wallets: true });
    const granted = await withWalletVisibility(staff, db);
    assert.equal(granted.role, 'sub_admin');
    assert.equal(canViewAllWallets(granted), true);
    assert.equal(vaultTransactionScope(granted).params[1], true);
    users = await listWalletVisibility(admin, db);
    assert.equal(users[1].view_all_wallets, true);
    await setWalletVisibility(admin, 2, false, db);
    assert.equal(canViewAllWallets(await withWalletVisibility(staff, db)), false);
    assert.equal(vaultTransactionScope(await withWalletVisibility(staff, db)).params[1], false);
    const rows = (await db.query("SELECT * FROM user_permissions WHERE module='wallet'")).rows;
    assert.equal(rows[0].can_read, true, 'revoking all-wallet visibility preserves own-wallet access');
    assert.equal(rows[0].can_write, false);
    assert.equal((await db.query("SELECT can_view_all FROM user_permissions WHERE module='expenses'")).rows[0].can_view_all, true);
    for (const id of [1, 3, 4, 5, 999]) await assert.rejects(setWalletVisibility(admin, id, true, db), error => error.statusCode === 404);
    for (const value of [null, 'true', 1]) await assert.rejects(setWalletVisibility(admin, 2, value, db), error => error.statusCode === 400);
    for (const id of ['2x', -1, '2147483648']) await assert.rejects(setWalletVisibility(admin, id, true, db), error => error.statusCode === 400);
    await assert.rejects(setWalletVisibility(staff, 2, true, db), error => error.statusCode === 403);
    await assert.rejects(listWalletVisibility(staff, db), error => error.statusCode === 403);
    await db.exec("UPDATE user_permissions SET can_read=false,can_view_all=true WHERE module='wallet'");
    assert.equal(canViewAllWallets(await withWalletVisibility(staff, db)), false, 'a denied module never grants all-wallet visibility');
    await setWalletVisibility(admin, 2, true, db);
    assert.equal(canViewAllWallets(await withWalletVisibility(staff, db)), true, 'explicitly enabling access restores View as well');
  } finally { await db.close(); }
});
