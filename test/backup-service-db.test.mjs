import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { exportBackup, previewBackup, restoreBackup, getBackupCatalog } from '../src/services/backup.service.js';
import { decodeBackup, encodeBackup, sha256Payload } from '../src/services/backupArchive.js';

// PGlite is a development dependency. BACKUP_DB_TEST_MODULE can optionally point
// at another dist/index.js. No application pool, .env file or network is used.
// PGlite executes the actual catalog SQL, DDL, constraints, triggers, transactions,
// advisory lock and sequence operations. Its only API adaptation is rowCount.
const modulePath = process.env.BACKUP_DB_TEST_MODULE;
const { PGlite } = await import(modulePath ? (modulePath.startsWith('file:') ? modulePath : pathToFileURL(modulePath).href) : '@electric-sql/pglite');

const SCHEMA = `
  CREATE TYPE account_state AS ENUM ('open', 'closed');
  CREATE TABLE users (
    id BIGSERIAL PRIMARY KEY, role TEXT NOT NULL, password TEXT NOT NULL,
    token_version INTEGER NOT NULL DEFAULT 0, is_active BOOLEAN NOT NULL DEFAULT true, refresh_token TEXT
  );
  CREATE TABLE user_sessions (
    id BIGSERIAL PRIMARY KEY, user_id BIGINT NOT NULL REFERENCES users(id), logout_time TIMESTAMPTZ
  );
  CREATE TABLE bank_accounts (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    owner_id BIGINT NOT NULL REFERENCES users(id),
    balance NUMERIC(40,12) NOT NULL, exact_bigint BIGINT NOT NULL,
    source_json JSON, indexed_json JSONB, blob BYTEA, observed_at TIMESTAMP(6),
    zoned_at TIMESTAMPTZ(6), labels TEXT[], state account_state,
    duration INTERVAL, ratio DOUBLE PRECISION,
    doubled_balance NUMERIC GENERATED ALWAYS AS (balance * 2) STORED
  );
  CREATE TABLE plots (id BIGSERIAL PRIMARY KEY, payment_id BIGINT);
  CREATE TABLE plot_payments (
    id BIGSERIAL PRIMARY KEY, plot_id BIGINT NOT NULL REFERENCES plots(id),
    bank_account_id BIGINT REFERENCES bank_accounts(id), amount NUMERIC(30,8) NOT NULL
  );
  ALTER TABLE plots ADD CONSTRAINT plots_payment_fk FOREIGN KEY(payment_id) REFERENCES plot_payments(id);
  CREATE TABLE day_book (
    id BIGSERIAL PRIMARY KEY, payment_id BIGINT UNIQUE NOT NULL REFERENCES plot_payments(id),
    amount NUMERIC(30,8) NOT NULL
  );
  CREATE TABLE application_settings (id BIGSERIAL PRIMARY KEY, label TEXT);
  CREATE SEQUENCE standalone_counter START 500;
  CREATE SEQUENCE countdown START -5 INCREMENT -1 MINVALUE -100 MAXVALUE -1;
  CREATE FUNCTION mirror_payment() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN INSERT INTO day_book(payment_id,amount) VALUES(NEW.id,NEW.amount); RETURN NEW; END $$;
  CREATE TRIGGER payments_mirror AFTER INSERT ON plot_payments FOR EACH ROW EXECUTE FUNCTION mirror_payment();
  CREATE FUNCTION block_ledger_changes() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN RAISE EXCEPTION 'ledger is append only'; END $$;
  CREATE TRIGGER ledger_guard BEFORE UPDATE OR DELETE ON day_book FOR EACH ROW EXECUTE FUNCTION block_ledger_changes();
  CREATE FUNCTION return_unchanged() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;
  CREATE TRIGGER ledger_replica BEFORE INSERT ON day_book FOR EACH ROW EXECUTE FUNCTION return_unchanged();
  ALTER TABLE day_book ENABLE REPLICA TRIGGER ledger_replica;
  CREATE TRIGGER ledger_disabled BEFORE INSERT ON day_book FOR EACH ROW EXECUTE FUNCTION return_unchanged();
  ALTER TABLE day_book DISABLE TRIGGER ledger_disabled;
  CREATE TRIGGER ledger_always BEFORE INSERT ON day_book FOR EACH ROW EXECUTE FUNCTION return_unchanged();
  ALTER TABLE day_book ENABLE ALWAYS TRIGGER ledger_always;
  CREATE VIEW account_totals AS SELECT sum(balance) AS total FROM bank_accounts;
  CREATE MATERIALIZED VIEW account_inverses AS SELECT id,1 / balance AS inverse_balance FROM bank_accounts;
`;

async function createDatabase(t, { seeded = true } = {}) {
  const sql = new PGlite();
  t.after(() => sql.close());
  await sql.exec(SCHEMA);
  const query = async (text, parameters) => {
    const result = await sql.query(text, parameters);
    return { ...result, rowCount: result.affectedRows };
  };
  let releases = 0;
  const db = { connect: async () => ({ query, release: () => { releases += 1; } }) };
  if (seeded) {
    await query("INSERT INTO users(role,password,token_version,refresh_token) VALUES ('super_admin','fixture-password-hash',3,'old-refresh-token')");
    await query('INSERT INTO user_sessions(user_id) VALUES(1)');
    await query(`INSERT INTO bank_accounts(owner_id,balance,exact_bigint,source_json,indexed_json,blob,observed_at,zoned_at,labels,state,duration,ratio)
      VALUES(1,$1::numeric,$2::bigint,$3::json,$4::jsonb,decode('00ff10abcd','hex'),$5::timestamp,$6::timestamptz,$7::text[],'open','2 months 3 days 04:05:06.123456',1.2345678901234567)`, [
      '99999999999999999999999.123456789012', '9007199254740993',
      '{ "amount": 9007199254740993, "unicode": "हिन्दी ₹", "keepWhitespace": true }',
      '{"amount":99999999999999999.123456789,"items":[null,"東京"]}',
      '2026-10-02 10:22:33.123456', '2026-10-02 10:22:33.654321+05:30',
      '{"हिन्दी","a,b",NULL,"東京"}',
    ]);
    await query('INSERT INTO plots DEFAULT VALUES');
    await query('INSERT INTO plot_payments(plot_id,bank_account_id,amount) VALUES(1,1,12345.12345678)');
    await query('UPDATE plots SET payment_id=1 WHERE id=1');
    await query("INSERT INTO application_settings(label) VALUES('monthly')");
    await query("SELECT nextval('standalone_counter'),nextval('countdown')");
    await query('REFRESH MATERIALIZED VIEW account_inverses');
  }
  return { sql, query, db, releases: () => releases };
}

async function snapshot(db, options = {}) {
  return exportBackup(db, { month: '2026-10', ...options });
}

async function restore(db, backup, mode = 'merge') {
  return restoreBackup(db, backup.buffer, {
    mode, checksum: backup.checksum,
    confirmation: mode === 'replace' ? 'REPLACE ALL DATA' : 'RESTORE',
  });
}

async function editedArchive(backup, change) {
  const payload = structuredClone(backup.payload);
  change(payload);
  return { payload, checksum: sha256Payload(payload), buffer: await encodeBackup(payload) };
}

function dataState(backup) {
  return { tables: backup.payload.tables, sequences: backup.payload.sequences, schema: backup.payload.schema };
}

function cell(backup, table, column, row = 0) {
  const data = backup.payload.tables.find(t => t.name === table);
  return data.rows[row][data.columns.indexOf(column)];
}

test('backup database integration (actual PostgreSQL engine)', async t => {
  await t.test('full export, decode and preview preserve all data types and include every module', async t => {
    const source = await createDatabase(t);
    const backup = await snapshot(source.db);
    const decoded = await decodeBackup(backup.buffer);
    assert.deepEqual(decoded.payload, backup.payload);
    assert.equal(cell(backup, 'bank_accounts', 'balance'), '99999999999999999999999.123456789012');
    assert.equal(cell(backup, 'bank_accounts', 'exact_bigint'), '9007199254740993');
    assert.equal(cell(backup, 'bank_accounts', 'blob'), '\\x00ff10abcd');
    assert.equal(cell(backup, 'bank_accounts', 'observed_at'), '2026-10-02 10:22:33.123456');
    assert.equal(cell(backup, 'bank_accounts', 'zoned_at'), '2026-10-02 04:52:33.654321+00');
    assert.equal(cell(backup, 'bank_accounts', 'source_json'), '{ "amount": 9007199254740993, "unicode": "हिन्दी ₹", "keepWhitespace": true }');
    assert.equal(cell(backup, 'bank_accounts', 'labels'), '{हिन्दी,"a,b",NULL,東京}');
    assert.equal(backup.payload.tables.find(t => t.name === 'bank_accounts').columns.includes('doubled_balance'), false);
    const preview = await previewBackup(source.db, backup.buffer);
    assert.equal(preview.compatible, true, preview.errors.join('; '));
    assert.deepEqual(preview.restoreModes, ['merge', 'replace']);
    assert.equal(preview.totalRows, 7);
    assert.deepEqual(preview.attachments, { includedFiles: 0, externalReferences: 0, bytes: 0 });
    const catalog = await getBackupCatalog(source.db);
    assert.ok(catalog.modules.some(m => m.id === 'banking'));
    assert.ok(catalog.modules.some(m => m.id === 'administration'));
    assert.ok(source.releases() >= 3);
  });

  await t.test('full replacement accepts a backup with an active admin account',async t=>{
    const target=await createDatabase(t);
    await target.query("UPDATE users SET role='admin'");
    const backup=await snapshot(target.db);
    await target.query("UPDATE users SET role='super_admin'");
    const restored=await restore(target.db,backup,'replace');
    assert.equal(restored.requiresLogin,true);
    assert.equal((await target.query('SELECT role FROM users WHERE id=1')).rows[0].role,'admin');
  });

  await t.test('one batched cursor covers wide/quoted/empty tables, multiple batches and true NULL values',async t=>{
    const source=await createDatabase(t);
    const wideName=`wide'table`;
    const columns=Array.from({length:120},(_,i)=>`"column_${i}" TEXT`).join(',');
    await source.query(`CREATE TABLE "${wideName}" (${columns})`);
    await source.query(`INSERT INTO "${wideName}" (column_0,column_119) VALUES ('NULL','हिन्दी "quoted"')`);
    await source.query('CREATE TABLE many_rows (id INTEGER PRIMARY KEY,value TEXT)');
    await source.query("INSERT INTO many_rows SELECT n,CASE WHEN n%2=0 THEN NULL ELSE 'NULL' END FROM generate_series(1,5001) n");
    await source.query('CREATE TABLE empty_module (id INTEGER)');
    let declarations=0,fetches=0;
    const db={connect:async()=>{
      const client=await source.db.connect();
      return {...client,query:async(text,params)=>{
        if(text.startsWith('DECLARE backup_rows')) declarations++;
        if(text.startsWith('FETCH FORWARD')) fetches++;
        return client.query(text,params);
      }};
    }};
    const backup=await snapshot(db);
    assert.equal(declarations,1);assert.equal(fetches,3);
    assert.equal(cell(backup,wideName,'column_0'),'NULL');
    assert.equal(cell(backup,wideName,'column_1'),null);
    assert.equal(cell(backup,wideName,'column_119'),'हिन्दी "quoted"');
    const rows=backup.payload.tables.find(table=>table.name==='many_rows').rows;
    assert.equal(rows.length,5001);
    assert.equal(rows.filter(row=>row[1]===null).length,2500);
    assert.equal(rows.filter(row=>row[1]==='NULL').length,2501);
    assert.equal(backup.payload.tables.find(table=>table.name==='empty_module').rows.length,0);
    assert.deepEqual((await decodeBackup(backup.buffer)).payload,backup.payload);
  });

  await t.test('records-only archives preserve every database row, preview file exclusions and restore original modules',async t=>{
    const source=await createDatabase(t);
    await source.query('CREATE TABLE documents (id INTEGER PRIMARY KEY, file_path TEXT)');
    await source.query("INSERT INTO documents VALUES(1,'local::not-present.pdf')");
    await assert.rejects(snapshot(source.db),/Cannot back up referenced attachment/);
    const backup=await snapshot(source.db,{includeFiles:false});
    assert.match(backup.filename,/records-only/);
    assert.equal(cell(backup,'documents','file_path'),'local::not-present.pdf');
    const preview=await previewBackup(source.db,backup.buffer);
    assert.equal(preview.compatible,true);
    assert.equal(preview.attachments.originalFilesExcluded,true);
    assert.ok(preview.warnings.some(warning=>warning.includes('Original uploaded files were excluded')));
    await source.query('DELETE FROM documents');
    await restore(source.db,backup);
    assert.equal((await source.query('SELECT file_path FROM documents')).rows[0].file_path,'local::not-present.pdf');
  });

  await t.test('merge into an empty matching schema restores FK cycles and suppresses mirrors, then is idempotent', async t => {
    const source = await createDatabase(t);
    const target = await createDatabase(t, { seeded: false });
    const backup = await snapshot(source.db);
    const restoreStart = Math.floor(Date.now() / 1000);
    const result = await restore(target.db, backup);
    assert.equal(result.inserted, 7);
    assert.equal(result.skipped, 0);
    const restored = await snapshot(target.db);
    const normalizedTables = tables => tables.map(table => {
      const ignored = table.name === 'users' ? ['token_version', 'refresh_token'] : table.name === 'user_sessions' ? ['logout_time'] : [];
      return { ...table, rows: table.rows.map(row => row.map((value, index) => ignored.includes(table.columns[index]) ? '[revoked during restore]' : value)) };
    });
    assert.deepEqual(normalizedTables(restored.payload.tables), normalizedTables(backup.payload.tables));
    assert.ok(Number(cell(restored, 'users', 'token_version')) >= restoreStart);
    assert.equal(cell(restored, 'users', 'refresh_token'), null);
    assert.notEqual(cell(restored, 'user_sessions', 'logout_time'), null);
    assert.deepEqual(restored.payload.schema, backup.payload.schema);
    const repeat = await restore(target.db, backup);
    assert.equal(repeat.inserted, 0);
    assert.equal(repeat.skipped, 7);
    const afterRepeat = await snapshot(target.db);
    assert.equal(cell(afterRepeat, 'users', 'token_version'), cell(restored, 'users', 'token_version'));
    assert.equal(cell(afterRepeat, 'user_sessions', 'logout_time'), cell(restored, 'user_sessions', 'logout_time'));
    assert.equal((await target.query('SELECT count(*)::text AS total FROM day_book')).rows[0].total, '1');
    await assert.rejects(target.query('UPDATE day_book SET amount=0'), /ledger is append only/);
    assert.equal((await target.query("SELECT nextval('bank_accounts_id_seq')::text AS next")).rows[0].next, '2');
    assert.equal((await target.query("SELECT nextval('standalone_counter')::text AS next")).rows[0].next, '501');
    assert.equal((await target.query("SELECT nextval('countdown')::text AS next")).rows[0].next, '-6');
    assert.equal((await target.query('SELECT doubled_balance::text AS value FROM bank_accounts')).rows[0].value, '199999999999999999999998.246913578024');
  });

  await t.test('replacement removes target-only rows, revokes credentials, preserves trigger states and restores sequences', async t => {
    const target = await createDatabase(t);
    const backup = await snapshot(target.db);
    await target.query("INSERT INTO users(role,password,token_version,refresh_token) VALUES('operator','later-password',20,'later-refresh')");
    await target.query("INSERT INTO application_settings(label) VALUES('later-setting')");
    await target.query("ALTER SEQUENCE standalone_counter RESTART WITH 999");
    const restoreStart = Math.floor(Date.now() / 1000);
    const result = await restore(target.db, backup, 'replace');
    assert.equal(result.requiresLogin, true);
    const restored = await snapshot(target.db);
    assert.deepEqual(restored.payload.schema, backup.payload.schema);
    assert.ok(Number(cell(restored, 'users', 'token_version')) >= restoreStart);
    assert.ok(Number(cell(restored, 'users', 'token_version')) > 20);
    assert.ok(Number(cell(restored, 'users', 'token_version')) > Number(cell(backup, 'users', 'token_version')));
    assert.equal(cell(restored, 'users', 'refresh_token'), null);
    assert.notEqual(cell(restored, 'user_sessions', 'logout_time'), null);
    assert.equal(restored.payload.tables.find(t => t.name === 'users').rows.length, 1);
    assert.equal(restored.payload.tables.find(t => t.name === 'application_settings').rows.length, 1);
    assert.equal((await target.query("SELECT nextval('standalone_counter')::text AS next")).rows[0].next, '501');
    assert.equal((await target.query("SELECT nextval('users_id_seq')::text AS next")).rows[0].next, '2');
    assert.equal((await target.query('SELECT count(*)::text AS total FROM account_inverses')).rows[0].total, '1');
    await assert.rejects(target.query('DELETE FROM day_book'), /ledger is append only/);
  });

  await t.test('module archives include linked records and restore to their original modules', async t => {
    const source = await createDatabase(t);
    const target = await createDatabase(t, { seeded: false });
    const backup = await snapshot(source.db, { modules: ['plots'] });
    const names = backup.payload.tables.map(t => t.name);
    for (const name of ['plots', 'plot_payments', 'day_book', 'bank_accounts', 'users', 'user_sessions']) assert.ok(names.includes(name), name);
    assert.equal(names.includes('application_settings'), false);
    const preview = await previewBackup(target.db, backup.buffer);
    assert.equal(preview.compatible, true, preview.errors.join('; '));
    assert.deepEqual(preview.restoreModes, ['merge']);
    assert.equal((await restore(target.db, backup)).inserted, 6);
    await assert.rejects(restore(target.db, backup, 'replace'), /Only a full backup/);
    assert.equal((await target.query('SELECT count(*)::text AS total FROM application_settings')).rows[0].total, '0');
  });

  await t.test('handcrafted module scopes and contradictory full-backup module labels are rejected without writes', async t => {
    const target = await createDatabase(t);
    const before = await snapshot(target.db);
    const moduleBackup = await snapshot(target.db, { modules: ['plots'] });
    const malformed = [
      await editedArchive(moduleBackup, payload => {
        // day_book is a reverse child and finance mirror, so no retained table
        // needs to reference it for the omitted data to still be required.
        payload.tables = payload.tables.filter(table => table.name !== 'day_book');
        payload.schema.tables = payload.schema.tables.filter(table => table.name !== 'day_book');
        payload.sequences = payload.sequences.filter(sequence => sequence.ownerTable !== 'day_book');
      }),
      await editedArchive(before, payload => { payload.kind = 'modules'; payload.requestedModules = ['plots']; }),
      await editedArchive(moduleBackup, payload => { payload.requestedModules = ['unrecognized-module']; }),
      await editedArchive(before, payload => { payload.requestedModules = ['plots']; }),
    ];
    for (const invalid of malformed) {
      const preview = await previewBackup(target.db, invalid.buffer);
      assert.equal(preview.compatible, false);
      assert.ok(preview.errors.some(error => /required related tables|valid backup modules|full backup must include all modules/.test(error)), preview.errors.join('; '));
      await assert.rejects(restore(target.db, invalid), error => error.statusCode === 409);
    }
    assert.deepEqual(dataState(await snapshot(target.db)), dataState(before));
  });

  await t.test('malformed schema entries produce an incompatible preview instead of an internal exception', async t => {
    const target = await createDatabase(t);
    const before = await snapshot(target.db);
    for (const invalidEntry of [null, {}, true, []]) {
      const invalid = await editedArchive(before, payload => { payload.schema.tables[0] = invalidEntry; });
      const preview = await previewBackup(target.db, invalid.buffer);
      assert.equal(preview.compatible, false);
      assert.ok(preview.errors.length > 0);
      await assert.rejects(restore(target.db, invalid, 'replace'), error => error.statusCode === 409);
    }
    assert.deepEqual(dataState(await snapshot(target.db)), dataState(before));
  });

  await t.test('merge keeps live sequence progress and advances past manually assigned IDs', async t => {
    const target = await createDatabase(t);
    const backup = await snapshot(target.db);
    await target.query("INSERT INTO users(id,role,password) VALUES(99,'operator','manual-id-password')");
    await target.query('ALTER SEQUENCE standalone_counter RESTART WITH 700');
    await target.query('ALTER SEQUENCE countdown RESTART WITH -20');
    const result = await restore(target.db, backup);
    assert.equal(result.inserted, 0);
    assert.equal(result.skipped, 7);
    assert.equal((await target.query("SELECT nextval('users_id_seq')::text AS next")).rows[0].next, '100');
    assert.equal((await target.query("SELECT nextval('standalone_counter')::text AS next")).rows[0].next, '700');
    assert.equal((await target.query("SELECT nextval('countdown')::text AS next")).rows[0].next, '-20');
  });

  await t.test('legacy rows covered by NOT VALID checks restore while the original future-write policy remains enforced', async t => {
    const target = await createDatabase(t);
    // Production messaging migrations retain historical EMAIL/WHATSAPP rows
    // while restricting future inserts with SMS-only NOT VALID check constraints.
    await target.query('CREATE TABLE client_message_deliveries (id BIGSERIAL PRIMARY KEY, channel TEXT)');
    await target.query("INSERT INTO client_message_deliveries(channel) VALUES('EMAIL')");
    await target.query("ALTER TABLE client_message_deliveries ADD CONSTRAINT channel_sms_only CHECK(channel='SMS') NOT VALID");
    await target.query('CREATE TABLE legacy_chat (id BIGSERIAL PRIMARY KEY, user_id BIGINT)');
    await target.query('INSERT INTO legacy_chat(user_id) VALUES(999)');
    await target.query('ALTER TABLE legacy_chat ADD CONSTRAINT legacy_chat_user_fk FOREIGN KEY(user_id) REFERENCES users(id) NOT VALID');
    const backup = await snapshot(target.db);
    await restore(target.db, backup, 'replace');
    const restored = await snapshot(target.db);
    assert.deepEqual(restored.payload.schema, backup.payload.schema);
    assert.equal(cell(restored, 'client_message_deliveries', 'channel'), 'EMAIL');
    const constraint = await target.query("SELECT convalidated FROM pg_constraint WHERE conname='channel_sms_only'");
    assert.equal(constraint.rows[0].convalidated, false);
    assert.equal(cell(restored, 'legacy_chat', 'user_id'), '999');
    assert.equal((await target.query("SELECT convalidated FROM pg_constraint WHERE conname='legacy_chat_user_fk'")).rows[0].convalidated, false);
    await assert.rejects(target.query("INSERT INTO client_message_deliveries(channel) VALUES('EMAIL')"), error => error.code === '23514');
    await assert.rejects(target.query('INSERT INTO legacy_chat(user_id) VALUES(998)'), error => error.code === '23503');
    await target.query("INSERT INTO client_message_deliveries(channel) VALUES('SMS')");
  });

  await t.test('dependent materialized views refresh in dependency order through intermediate regular views', async t => {
    const target = await createDatabase(t);
    await target.query('CREATE MATERIALIZED VIEW z_base AS SELECT sum(amount) AS total FROM plot_payments');
    await target.query('CREATE VIEW middle AS SELECT total * 2 AS doubled FROM z_base');
    await target.query('CREATE MATERIALIZED VIEW a_derived AS SELECT doubled FROM middle');
    const backup = await snapshot(target.db);
    assert.deepEqual(backup.payload.schema.views.find(view => view.name === 'a_derived').dependencies, ['middle']);
    assert.deepEqual(backup.payload.schema.views.find(view => view.name === 'middle').dependencies, ['z_base']);
    await target.query('UPDATE plot_payments SET amount=10');
    await target.query('REFRESH MATERIALIZED VIEW z_base');
    await target.query('REFRESH MATERIALIZED VIEW a_derived');
    assert.equal((await target.query('SELECT doubled::text AS total FROM a_derived')).rows[0].total, '20.00000000');
    await restore(target.db, backup, 'replace');
    assert.equal((await target.query('SELECT doubled::text AS total FROM a_derived')).rows[0].total, '24690.24691356');
    assert.equal((await target.query('SELECT total::text FROM z_base')).rows[0].total, '12345.12345678');
  });

  await t.test('inherited tables fail closed rather than exporting child rows twice', async t => {
    const target = await createDatabase(t);
    await target.query('CREATE TABLE inherited_parent (id INTEGER, value TEXT)');
    await target.query('CREATE TABLE inherited_child () INHERITS(inherited_parent)');
    await target.query("INSERT INTO inherited_child VALUES(1,'only child')");
    await assert.rejects(snapshot(target.db), error => error.statusCode === 409 && /inherited/.test(error.message));
    await assert.rejects(getBackupCatalog(target.db), error => error.statusCode === 409 && /inherited/.test(error.message));
    assert.equal((await target.query('SELECT count(*)::text AS total FROM inherited_child')).rows[0].total, '1');
  });

  await t.test('merge conflicts roll back earlier inserts and all temporary FK and trigger changes', async t => {
    const source = await createDatabase(t);
    const target = await createDatabase(t, { seeded: false });
    const backup = await snapshot(source.db);
    await target.query("INSERT INTO users(role,password,token_version,refresh_token) VALUES('super_admin','different-password',3,'old-refresh-token')");
    const before = await snapshot(target.db);
    await assert.rejects(restore(target.db, backup), error => error.statusCode === 409 && /conflicts/.test(error.message));
    assert.deepEqual(dataState(await snapshot(target.db)), dataState(before));
  });

  await t.test('deferred foreign-key validation failure rolls back replacement data, sequences and schema', async t => {
    const target = await createDatabase(t);
    const before = await snapshot(target.db);
    const broken = await editedArchive(before, payload => {
      const payments = payload.tables.find(table => table.name === 'plot_payments');
      payments.rows[0][payments.columns.indexOf('plot_id')] = '999999';
    });
    await assert.rejects(restore(target.db, broken, 'replace'), error => error.statusCode === 409 && /rolled back/.test(error.message));
    assert.deepEqual(dataState(await snapshot(target.db)), dataState(before));
    await assert.rejects(target.query('DELETE FROM day_book'), /ledger is append only/);
  });

  await t.test('failure after sequence restarts still rolls back data, sequence positions and trigger states', async t => {
    const target = await createDatabase(t);
    await target.query('ALTER SEQUENCE standalone_counter RESTART WITH 700');
    const before = await snapshot(target.db);
    const broken = await editedArchive(before, payload => {
      const accounts = payload.tables.find(table => table.name === 'bank_accounts');
      accounts.rows[0][accounts.columns.indexOf('balance')] = '0';
      payload.sequences.find(sequence => sequence.name === 'standalone_counter').lastValue = '600';
    });
    // The materialized view divides by balance. Refresh happens only AFTER
    // transactional sequence restarts and restoring trigger/constraint states.
    await assert.rejects(restore(target.db, broken, 'replace'), /division by zero/);
    assert.deepEqual(dataState(await snapshot(target.db)), dataState(before));
    assert.equal((await target.query("SELECT nextval('standalone_counter')::text AS next")).rows[0].next, '700');
  });

  await t.test('new target columns or tables reject a full archive before modifying data', async t => {
    const target = await createDatabase(t);
    const backup = await snapshot(target.db);
    await target.query('ALTER TABLE bank_accounts ADD COLUMN future_column TEXT');
    let preview = await previewBackup(target.db, backup.buffer);
    assert.equal(preview.compatible, false);
    assert.ok(preview.errors.some(error => /Schema differs for bank_accounts/.test(error)));
    await assert.rejects(restore(target.db, backup, 'replace'), error => error.statusCode === 409);
    await target.query('ALTER TABLE bank_accounts DROP COLUMN future_column');
    await target.query('CREATE TABLE future_module (id INTEGER PRIMARY KEY)');
    preview = await previewBackup(target.db, backup.buffer);
    assert.equal(preview.compatible, false);
    assert.ok(preview.errors.some(error => /every target table/.test(error)));
    await assert.rejects(restore(target.db, backup, 'replace'), error => error.statusCode === 409);
    assert.equal((await target.query('SELECT count(*)::text AS total FROM bank_accounts')).rows[0].total, '1');
  });

  await t.test('missing or changed sequence definitions are incompatible and cannot restore', async t => {
    const target = await createDatabase(t);
    const before = await snapshot(target.db);
    for (const mutation of [
      payload => { payload.sequences.pop(); },
      payload => { payload.sequences[0].increment = '5'; },
      payload => { payload.sequences[0].lastValue = '999999999999999999999999999999'; },
    ]) {
      const invalid = await editedArchive(before, mutation);
      const preview = await previewBackup(target.db, invalid.buffer);
      assert.equal(preview.compatible, false);
      assert.ok(preview.errors.some(error => /sequence/i.test(error)));
      await assert.rejects(restore(target.db, invalid, 'replace'), /sequence/i);
    }
    assert.deepEqual(dataState(await snapshot(target.db)), dataState(before));
  });
});
