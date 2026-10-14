import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { up as vaultUp } from '../src/migrations/199_loyalty_vault.js';
import { repairWalletTransferSite, WALLET_SITE_ATTRIBUTION_REPAIR as target } from '../src/services/walletSiteAttributionRepair.service.js';

async function fixture() {
  const { PGlite } = await import(process.env.PGLITE_MODULE);
  const pg = new PGlite();
  const query = async (sql, args) => {
    const result = args?.length ? await pg.query(sql, args) : (await pg.exec(sql)).at(-1);
    return { ...result, rows: result?.rows || [], rowCount: result?.affectedRows ?? result?.rows?.length ?? 0 };
  };
  const database = { query, connect: async () => ({ query, release() {} }) };
  await query(`CREATE TABLE app_schema_migrations(version text PRIMARY KEY);
    CREATE TABLE sites(id int PRIMARY KEY,name text,organization_id int);
    INSERT INTO sites VALUES(2,'Live project',1),(6,'BALAJI ASSOCIATES',1),(9,'Green Valley Test',1);
    CREATE TABLE users(id int PRIMARY KEY,name text,role text,organization_id int,is_active boolean DEFAULT true);
    INSERT INTO users VALUES(6,'SACHIN KUMAR','sub_admin',1,true),(7,'Kuldeep Tomar','admin',1,true);
    CREATE TABLE members(id int PRIMARY KEY,site_id int,full_name text);
    CREATE TABLE cash_flow_entries(id int PRIMARY KEY,source_module text,source_id int);
  `);
  // Install the production immutable ledger and production apply_delta helper;
  // no copied/stubbed accounting function is used in these repair tests.
  await vaultUp(database);
  await query("SELECT loyalty_vault_apply_delta('user:6',1,30000,'credit','Live project receipt',NULL,NULL,NULL,6)");
  await query("SELECT loyalty_vault_apply_delta('user:7',1,2000000,'credit','Other live project receipt',NULL,NULL,NULL,2)");
  await query(`INSERT INTO loyalty_vault_transfers(id,organization_id,from_holder_type,from_holder_id,to_holder_id,
    sender_id,recipient_id,amount,status,idempotency_key,resolved_at,resolved_by)
    VALUES($1,1,'user',7,6,7,6,1504000,'accepted','00000000-0000-4000-8000-000000000001',now(),6)`, [target.transferId]);
  await query("SELECT setval('loyalty_vault_entries_id_seq',103,false)");
  await query("SELECT loyalty_vault_apply_delta('user:7',1,-1504000,'transfer_out','Cash handover accepted',NULL,NULL,NULL,NULL,6,$1)", [target.transferId]);
  await query("SELECT loyalty_vault_apply_delta('user:6',1,1504000,'transfer_in','Cash handover received',NULL,NULL,NULL,NULL,6,$1)", [target.transferId]);
  const snapshot = async () => ({
    transfers: (await query('SELECT * FROM loyalty_vault_transfers ORDER BY id')).rows,
    entries: (await query('SELECT * FROM loyalty_vault_entries ORDER BY id')).rows,
    accounts: (await query('SELECT * FROM loyalty_vault_accounts ORDER BY holder_key')).rows,
    sourceRows: (await query('SELECT * FROM cash_flow_entries ORDER BY id')).rows,
  });
  return { pg, query, database, snapshot };
}
const databaseTest = { skip: !process.env.PGLITE_MODULE };
const conflict = error => error.code === 'WALLET_SITE_REPAIR_CONFLICT';

test('repair defaults to a fully validated dry-run without changing any records', databaseTest, async () => {
  const f = await fixture();
  try {
    const before = await f.snapshot();
    const report = await repairWalletTransferSite(f.database);
    assert.equal(report.status, 'dry_run');
    assert.equal(report.applied, false);
    assert.deepEqual(report.plannedEntries.map(entry => [entry.holderKey, entry.siteId, entry.kind, entry.amountPaise]), [
      ['user:7', null, 'reversal', '150400000'], ['user:7', 9, 'adjustment', '-150400000'],
      ['user:6', null, 'reversal', '-150400000'], ['user:6', 9, 'adjustment', '150400000'],
    ]);
    assert.deepEqual(await f.snapshot(), before);
  } finally { await f.pg.close(); }
});

test('approved repair snapshots before mutation, appends four audited entries and replays without changes', databaseTest, async () => {
  const f = await fixture();
  try {
    const before = await f.snapshot();
    let written;
    const report = await repairWalletTransferSite(f.database, { apply: true, beforeSnapshotWriter: async evidence => {
      written = evidence;
      assert.deepEqual(await f.snapshot(), before, 'snapshot must finish before any mutation');
    } });
    assert.equal(written.status, 'ready_to_apply');
    assert.equal(report.status, 'applied');
    const after = await f.snapshot();
    assert.deepEqual(after.entries.slice(0, before.entries.length), before.entries);
    assert.equal(after.entries.length, before.entries.length + 4);
    assert.equal(after.transfers[0].site_id, 9);
    assert.deepEqual({ ...after.transfers[0], site_id: null }, before.transfers[0]);
    assert.deepEqual(after.sourceRows, before.sourceRows);
    const money = rows => rows.map(({ holder_key, balance, reserved_balance }) => ({ holder_key, balance, reserved_balance }));
    assert.deepEqual(money(after.accounts), money(before.accounts));
    assert.deepEqual(after.entries.slice(-4).map(row => [row.holder_key, row.site_id, row.kind, Number(row.amount), row.transfer_id]), [
      ['user:7', null, 'reversal', 1504000, null], ['user:7', 9, 'adjustment', -1504000, null],
      ['user:6', null, 'reversal', -1504000, null], ['user:6', 9, 'adjustment', 1504000, null],
    ]);
    for (const row of after.entries.slice(-4)) {
      assert.equal(row.details.repair_key, target.repairKey);
      assert.equal(row.details.attributed_transfer_id, target.transferId);
      assert.match(row.description, new RegExp(target.transferId));
    }
    assert.equal(Number(report.after.siteBalances.find(row => row.holder_key === 'user:6' && row.site_id === 6).balance), 30000);
    assert.equal(Number(report.after.siteBalances.find(row => row.holder_key === 'user:6' && row.site_id === 9).balance), 1504000);
    assert.equal(Number(report.after.siteBalances.find(row => row.holder_key === 'user:7' && row.site_id === 2).balance), 2000000);
    assert.ok(report.after.siteBalances.filter(row => row.site_id == null).every(row => Number(row.balance) === 0));
    const replay = await repairWalletTransferSite(f.database, { apply: true, beforeSnapshotWriter: () => assert.fail('replay must not write new evidence or postings') });
    assert.equal(replay.status, 'already_applied');
    assert.equal(replay.applied, false);
    assert.deepEqual(await f.snapshot(), after);
    await assert.rejects(f.query('UPDATE loyalty_vault_entries SET amount=1 WHERE id=103'), /immutable/);
  } finally { await f.pg.close(); }
});

test('failed or missing snapshot writer prevents every financial mutation', databaseTest, async () => {
  const f = await fixture();
  try {
    const before = await f.snapshot();
    await assert.rejects(repairWalletTransferSite(f.database, { apply: true }), conflict);
    await assert.rejects(repairWalletTransferSite(f.database, { apply: true, beforeSnapshotWriter: () => { throw new Error('disk full'); } }), /disk full/);
    assert.deepEqual(await f.snapshot(), before);
  } finally { await f.pg.close(); }
});

test('wrong amount, site, actor, or preclassified transfer fails closed', databaseTest, async t => {
  for (const [label, sql, options = {}] of [
    ['amount', 'UPDATE loyalty_vault_transfers SET amount=1504001'],
    ['status', "UPDATE loyalty_vault_transfers SET status='rejected'"],
    ['site name', "UPDATE sites SET name='Production project' WHERE id=9"],
    ['site organization', 'UPDATE sites SET organization_id=2 WHERE id=9'],
    ['actor inactive', 'UPDATE users SET is_active=false WHERE id=7'],
    ['actor role', "UPDATE users SET role='sub_admin' WHERE id=7"],
    ['different actor', null, { actorId: 6 }],
    ['preclassified', 'UPDATE loyalty_vault_transfers SET site_id=6'],
  ]) await t.test(label, async () => {
    const f = await fixture();
    try {
      if (sql) await f.query(sql);
      const before = await f.snapshot();
      await assert.rejects(repairWalletTransferSite(f.database, { ...options, apply: true, beforeSnapshotWriter: () => assert.fail('conflicting target must not reach snapshot writer') }), conflict);
      assert.deepEqual(await f.snapshot(), before);
    } finally { await f.pg.close(); }
  });
});

test('partial corrections or unexpected unallocated cash cannot be silently repaired', databaseTest, async () => {
  const f = await fixture();
  try {
    await f.query("SELECT loyalty_vault_apply_delta('user:6',1,1,'adjustment','Unrelated legacy cash')");
    const before = await f.snapshot();
    await assert.rejects(repairWalletTransferSite(f.database, { apply: true, beforeSnapshotWriter: () => assert.fail('unexpected null balance') }), conflict);
    assert.deepEqual(await f.snapshot(), before);
  } finally { await f.pg.close(); }
  const partial = await fixture();
  try {
    await partial.query("SELECT loyalty_vault_apply_delta('user:6',1,-1504000,'reversal','Partial correction',NULL,NULL,NULL,NULL,7,NULL,$1)", [{ repair_key: target.repairKey }]);
    const before = await partial.snapshot();
    await assert.rejects(repairWalletTransferSite(partial.database), conflict);
    assert.deepEqual(await partial.snapshot(), before);
  } finally { await partial.pg.close(); }
});

test('failure after posting starts rolls the entire correction back', databaseTest, async () => {
  const f = await fixture();
  try {
    const before = await f.snapshot();
    const broken = { connect: async () => ({ release() {}, query: (sql, values) => {
      if (sql.startsWith('UPDATE loyalty_vault_transfers SET site_id=')) throw new Error('injected final update failure');
      return f.query(sql, values);
    } }) };
    await assert.rejects(repairWalletTransferSite(broken, { apply: true, beforeSnapshotWriter() {} }), /injected final update failure/);
    assert.deepEqual(await f.snapshot(), before);
  } finally { await f.pg.close(); }
});

test('CLI refuses --apply without an output path before connecting to the database', () => {
  const result = spawnSync(process.execPath, ['scripts/assign-sachin-wallet-test-site.mjs', '--apply'], { encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--apply requires --output/);
  assert.equal(result.stdout, '');
});
