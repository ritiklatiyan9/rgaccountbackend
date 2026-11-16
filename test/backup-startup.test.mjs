import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { up as loginMigration, migrationSql as loginSql } from '../src/migrations/228_booking_accounts_login_access.js';
import { up as backupMigration } from '../src/migrations/249_native_backups.js';

test('installed login and backup migrations take a read-only startup path and preserve access choices', async t => {
  const engine = new PGlite(); t.after(() => engine.close());
  await engine.exec('CREATE TABLE users(id INTEGER PRIMARY KEY); INSERT INTO users VALUES(1)');
  const queries = [];
  const query = async (sql, values) => {
    queries.push(sql);
    return values ? engine.query(sql, values) : (await engine.exec(sql)).at(-1) || { rows: [] };
  };
  const database = { query, connect: async () => ({ query, release() {} }) };
  assert.equal(await loginMigration(database), true);
  assert.equal(await backupMigration(database), true);
  await engine.exec('UPDATE users SET can_login_accounts=false,can_login_booking=false,can_login_booking_accounts=true');
  await engine.exec("INSERT INTO backup_control.jobs(id,owner_id,kind,scope,max_attempts,storage_destination) VALUES('11111111-1111-1111-1111-111111111111','1','backup','database',3,'Private S3')");
  queries.length = 0;
  assert.equal(await loginMigration(database), false);
  assert.equal(await backupMigration(database), false);
  assert.ok(queries.every(sql => sql.startsWith('SELECT')), 'installed migrations must not execute DDL or acquire exclusive table locks');
  assert.deepEqual((await engine.query('SELECT can_login_accounts,can_login_booking,can_login_booking_accounts FROM users')).rows,
    [{ can_login_accounts: false, can_login_booking: false, can_login_booking_accounts: true }]);
  assert.equal((await engine.query('SELECT status FROM backup_control.jobs')).rows[0].status, 'queued');
});

test('live users reads reproduce the former deploy lock timeout while the installed migration now succeeds', { skip: !process.env.BACKUP_STARTUP_TEST_DATABASE_URL }, async t => {
  const url = new URL(process.env.BACKUP_STARTUP_TEST_DATABASE_URL);
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)); assert.match(url.pathname, /_test$/);
  const { default: pg } = await import('pg');
  const admin = new pg.Client({ connectionString: url.href }); await admin.connect();
  const name = `backup_startup_${randomUUID().replaceAll('-', '')}_test`;
  await admin.query(`CREATE DATABASE ${name} TEMPLATE template0`);
  url.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: url.href, max: 3 });
  t.after(async () => { await pool.end(); await admin.query(`DROP DATABASE ${name} WITH (FORCE)`); await admin.end(); });
  await pool.query('CREATE TABLE users(id INTEGER PRIMARY KEY)');
  await loginMigration(pool);
  const reader = await pool.connect(); const legacy = await pool.connect();
  try {
    await reader.query('BEGIN'); await reader.query('SELECT * FROM users');
    await legacy.query('BEGIN'); await legacy.query("SET LOCAL lock_timeout='50ms'");
    await assert.rejects(legacy.query(loginSql), { code: '55P03' });
    await legacy.query('ROLLBACK');
    assert.equal(await loginMigration(pool), false, 'a live read must no longer prevent this deployment migration');
  } finally { await reader.query('ROLLBACK'); reader.release(); legacy.release(); }
});
