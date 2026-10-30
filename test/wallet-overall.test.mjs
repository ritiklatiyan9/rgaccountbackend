import assert from 'node:assert/strict';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { getOverallWalletOverview, buildOverallWalletOverview } from '../src/services/overallWallet.service.js';
import { overall } from '../src/controllers/loyaltyVault.controller.js';
import pool from '../src/config/db.js';

const admin = { id: 1, name: 'Kuldeep Tomar', organization_id: 1, role: 'admin', is_active: true };
const viewer = { id: 4, organization_id: 1, role: 'sub_admin', is_active: true, wallet_can_read: true, wallet_view_all: true };
const forbidden = error => error.statusCode === 403;

test('overall wallet rejects own-wallet-only, disabled, inactive and unsupported accounts before reading balances', async () => {
  const database = { connect() { throw new Error('Unauthorized balance query'); } };
  for (const actor of [
    { ...viewer, wallet_view_all: false }, { ...viewer, wallet_can_read: false },
    { ...viewer, is_active: false }, { ...viewer, role: 'member' }, null,
  ]) await assert.rejects(getOverallWalletOverview(actor, database), forbidden);
});

test('overall wallet handles empty portfolios without inventing an authority wallet', () => {
  const result = buildOverallWalletOverview([], [], [admin]);
  assert.equal(result.top_authority, null);
  assert.equal(result.top_authority_status, 'not_found');
  assert.equal(result.totals.balance, '0.00');
  assert.equal(result.totals.site_count, 0);
  assert.deepEqual(result.holders, []);
});

test('overall wallet reconciles exact user custody across authorized sites without changing records', async t => {
  const pg = new PGlite();
  const statements = [];
  const query = async (sql, args) => {
    statements.push(sql);
    const result = args?.length ? await pg.query(sql, args) : (await pg.exec(sql)).at(-1);
    return { ...result, rows: result?.rows || [] };
  };
  const database = { options: { max: 3 }, query, connect: async () => ({ query, release() {} }) };
  try {
    await pg.exec(`CREATE TABLE users(id int PRIMARY KEY,name text,role text,organization_id int,is_active boolean);
      INSERT INTO users VALUES(1,'  KuLdEeP   Tomar  ','admin',1,true),(2,'Sunny','sub_admin',1,true),
        (3,'Retired collector','sub_admin',1,false),(4,'Site viewer','sub_admin',1,true),
        (5,'Kuldeep Tomar','admin',2,true),(6,'Unassigned viewer','sub_admin',1,true);
      CREATE TABLE sites(id int PRIMARY KEY,name text,organization_id int,include_in_overall boolean NOT NULL DEFAULT true);
      INSERT INTO sites(id,name,organization_id) VALUES(10,'Defence Garden',1),(11,'DG Associates',1),(12,'New project',1),(20,'Private organization',2);
      CREATE TABLE user_sites(user_id int,site_id int);
      INSERT INTO user_sites VALUES(2,10),(2,11),(4,10);
      CREATE TABLE user_permissions(user_id int,module text,can_read boolean,can_view_all boolean);
      INSERT INTO user_permissions VALUES(4,'wallet',true,true),(6,'wallet',true,true);
      CREATE TABLE loyalty_vault_entries(id serial PRIMARY KEY,organization_id int,site_id int,holder_key text,
        holder_type text,holder_id int,amount numeric(16,2),source_table text,created_at timestamptz DEFAULT now());
      INSERT INTO loyalty_vault_entries(organization_id,site_id,holder_key,holder_type,holder_id,amount) VALUES
        (1,10,'user:1','user',1,100.10),(1,11,'user:1','user',1,200.20),
        (1,10,'user:2','user',2,50.05),(1,11,'user:2','user',2,-0.07),
        (1,10,'user:3','user',3,-10.11),(1,11,'user:3','user',3,4.04),
        (1,NULL,'user:1','user',1,99.99),(1,10,'member:1','member',1,999.99),
        (2,20,'user:5','user',5,90000.00);`);
    const before = (await pg.query('SELECT * FROM loyalty_vault_entries ORDER BY id')).rows;

    await t.test('portfolio and per-site totals count each user posting exactly once, including negative paise', async () => {
      const result = await getOverallWalletOverview(admin, database);
      assert.equal(result.scope, 'accessible_sites');
      assert.equal(result.wallet_holders, 'users');
      assert.deepEqual(result.sites.map(site => site.site_id).sort(), [10, 11, 12]);
      assert.deepEqual(result.totals, {
        balance: '344.21', available_balance: '344.21', reserved_balance: '0.00',
        site_count: 3, holder_count: 4, other_holders_balance: '43.91',
      });
      assert.equal(result.top_authority.holder_id, 1);
      assert.equal(result.top_authority.balance, '300.30');
      assert.equal(result.top_authority.site_count, 3);
      assert.equal(result.holders.find(holder => holder.holder_id === 2).balance, '49.98');
      assert.equal(result.holders.find(holder => holder.holder_id === 3).balance, '-6.07');
      assert.equal(result.holders.find(holder => holder.holder_id === 3).is_active, false);
      assert.deepEqual(result.sites.find(site => site.site_id === 10).holders.map(holder => holder.holder_type), ['user','user','user','user']);
      assert.equal(result.sites.find(site => site.site_id === 10).balance, '140.04');
      assert.equal(result.sites.find(site => site.site_id === 11).balance, '204.17');
      assert.equal(result.sites.find(site => site.site_id === 12).balance, '0.00');
      assert.equal(result.sites.find(site => site.site_id === 12).top_authority_balance, '0.00');
      assert.equal(result.unallocated.balance, '99.99', 'legacy cash is metadata, never duplicated into project totals');
      assert.equal(result.unallocated.entry_count, 1);
      assert.equal(result.holders.some(holder => holder.holder_id === 5), false);
      assert.equal(result.holders.some(holder => holder.holder_id === 6), false);
      for (const site of result.sites) {
        assert.equal(new Set(site.holders.map(holder => holder.holder_key)).size, site.holders.length);
      }
      assert.equal(statements.filter(sql => sql.includes('FROM holder_sites h')).length, 1, 'all holders share one ledger aggregation');
      assert.ok(statements.includes('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'));
    });

    await t.test('a viewing grant keeps organization and site restrictions and omits global unallocated cash', async () => {
      const result = await getOverallWalletOverview(viewer, database);
      assert.deepEqual(result.sites.map(site => site.site_id), [10]);
      assert.equal(result.totals.balance, '140.04');
      assert.equal(result.top_authority.balance, '100.10');
      assert.equal(result.totals.other_holders_balance, '39.94');
      assert.equal(result.unallocated, null);
      assert.equal(result.holders.find(holder => holder.holder_id === 2).balance, '50.05');
      const empty = await getOverallWalletOverview({ ...viewer, id: 6 }, database);
      assert.deepEqual(empty.sites, []);
      assert.equal(empty.top_authority, null);
      assert.equal(empty.totals.balance, '0.00');
    });

    await t.test('switching a site off removes its custody from all totals and shared holders immediately, then switching on restores it', async () => {
      // Prime an earlier all-sites read: a switch must apply on the next request,
      // independently of a browser's selected project or previous totals.
      assert.equal((await getOverallWalletOverview(admin, database)).totals.balance, '344.21');
      await pg.exec("UPDATE sites SET include_in_overall=false WHERE id=11");
      const result = await getOverallWalletOverview(admin, database);
      assert.deepEqual(result.sites.map(site => site.site_id).sort(), [10,12]);
      assert.equal(result.totals.balance, '140.04');
      assert.equal(result.totals.available_balance, '140.04');
      assert.equal(result.totals.reserved_balance, '0.00');
      assert.equal(result.totals.site_count, 2);
      assert.equal(result.top_authority.balance, '100.10');
      assert.equal(result.holders.find(holder => holder.holder_id === 2).balance, '50.05');
      assert.ok(result.holders.every(holder => holder.sites.every(site => site.site_id !== 11)));
      // Hiding an overall report must not alter or hide an individual site's cash.
      const individual = await pg.query(`SELECT COALESCE(sum(amount),0)::text AS balance
        FROM loyalty_vault_entries WHERE organization_id=1 AND site_id=11 AND holder_type='user'`);
      assert.equal(individual.rows[0].balance, '204.17');
      await pg.exec("UPDATE sites SET include_in_overall=true WHERE id=11");
      const restored = await getOverallWalletOverview(admin, database);
      assert.equal(restored.totals.balance, '344.21');
      assert.equal(restored.top_authority.balance, '300.30');
      assert.equal(restored.holders.find(holder => holder.holder_id === 2).balance, '49.98');
    });

    await t.test('an off site is excluded before expensive aligned-cash corrections or granted-user totals', async () => {
      await pg.exec("UPDATE sites SET include_in_overall=false WHERE id=10; UPDATE loyalty_vault_entries SET source_table='manual_wallet_site_cash_alignment' WHERE site_id=10 AND holder_id=1");
      const start = statements.length;
      const result = await getOverallWalletOverview(admin, database);
      assert.deepEqual(result.sites.map(site => site.site_id).sort(), [11,12]);
      assert.equal(result.totals.balance, '204.17');
      assert.equal(statements.slice(start).some(sql => sql.includes('WITH aligned AS')), false,
        'an excluded site cannot trigger its site cash projection');
      const granted = await getOverallWalletOverview(viewer, database);
      assert.deepEqual(granted.sites, []);
      assert.deepEqual(granted.holders, []);
      assert.equal(granted.top_authority, null);
      assert.equal(granted.totals.balance, '0.00');
      await pg.exec("UPDATE loyalty_vault_entries SET source_table=NULL WHERE site_id=10; UPDATE sites SET include_in_overall=false WHERE organization_id=1");
      const empty = await getOverallWalletOverview(admin, database);
      assert.deepEqual(empty.sites, []);
      assert.deepEqual(empty.holders, []);
      assert.equal(empty.totals.site_count, 0);
      assert.equal(empty.totals.balance, '0.00');
      assert.equal(empty.totals.available_balance, '0.00');
      assert.equal(empty.top_authority, null);
      assert.equal(empty.unallocated.balance, '99.99', 'legacy unallocated custody remains metadata outside project totals');
      await pg.exec("UPDATE sites SET include_in_overall=true WHERE organization_id=1");
    });

    await t.test('the controller ignores selected-site narrowing, applies current read permission and disables caching', async () => {
      const originalQuery = pool.query, originalConnect = pool.connect;
      pool.query = query; pool.connect = database.connect;
      const invoke = (user = 4, extraQuery = {}) => new Promise((resolve, reject) => overall({
        user: { id: user }, query: extraQuery, path: '/overall',
      }, { set(name, value) { assert.equal(name, 'Cache-Control'); assert.equal(value, 'no-store'); return this; }, json: resolve }, reject));
      try {
        const result = await invoke(1, { site_id: 20 });
        assert.deepEqual(result.sites.map(site => site.site_id).sort(), [10,11,12]);
        assert.equal((await invoke()).totals.balance, '140.04');
        await pg.exec("UPDATE user_permissions SET can_read=false WHERE user_id=4 AND module='wallet'");
        await assert.rejects(invoke(), forbidden);
        await pg.exec("UPDATE user_permissions SET can_read=true,can_view_all=false WHERE user_id=4 AND module='wallet'");
        await assert.rejects(invoke(), forbidden);
      } finally { pool.query = originalQuery; pool.connect = originalConnect; }
    });

    await t.test('authority matching never substitutes another account or another organization', async () => {
      await pg.exec("UPDATE users SET name='Kuldeep' WHERE id=1");
      let result = await getOverallWalletOverview(admin, database);
      assert.equal(result.top_authority, null);
      assert.equal(result.top_authority_status, 'not_found');
      assert.ok(result.sites.every(site => site.top_authority_balance === null));
      assert.equal(result.totals.other_holders_balance, null);
      await pg.exec("UPDATE users SET name='Kuldeep Tomar' WHERE id=1; INSERT INTO users VALUES(7,'kuldeep tomar','super_admin',1,true)");
      result = await getOverallWalletOverview(admin, database);
      assert.equal(result.top_authority, null);
      assert.equal(result.top_authority_status, 'ambiguous');
      await pg.exec("UPDATE users SET is_active=false WHERE id=7");
      result = await getOverallWalletOverview(admin, database);
      assert.equal(result.top_authority.holder_id, 1);
    });
    assert.deepEqual((await pg.query('SELECT * FROM loyalty_vault_entries ORDER BY id')).rows, before, 'every portfolio query is read-only');
  } finally { await pg.close(); }
});
