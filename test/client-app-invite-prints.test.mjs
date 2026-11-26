import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import pool from '../src/config/db.js';
import { getClientAppInvitePrintCount, getReceiptHistory, recordClientAppInvitePrint, recordReceiptPrint } from '../src/controllers/receiptHistory.controller.js';

function table(migration, name) {
  const source = readFileSync(new URL(`../src/migrations/${migration}`, import.meta.url), 'utf8');
  return source.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${name} \\([\\s\\S]*?\\n\\s*\\)`))[0];
}

function invoke(handler, options = {}) {
  const user = { id: 4, role: 'sub_admin', organization_id: 1 };
  return new Promise((resolve, reject) => {
    const req = { user, params: { id: '20' }, query: { site_id: '7' }, body: {}, headers: {}, get: () => '', ...options };
    const res = { code: 200, set() {}, status(code) { this.code = code; return this; },
      json(data) { resolve({ code: this.code, data }); } };
    handler(req, res, reject);
  });
}

test('client invite counts are site-scoped, persisted, and count one print per request ID', async t => {
  const sql = new PGlite();
  t.after(() => sql.close());
  await sql.exec(`CREATE TABLE sites(id integer, name text, organization_id integer);
    INSERT INTO sites VALUES (7, 'Allowed', 1), (8, 'Other site', 1), (9, 'Other organization', 2);
    CREATE TABLE user_sites(user_id integer, site_id integer);
    INSERT INTO user_sites VALUES (4, 7), (4, 9);
    CREATE TABLE members(id integer PRIMARY KEY, site_id integer, member_type text, member_types text[]);
    INSERT INTO members VALUES (20, 7, 'MEMBER', ARRAY['MEMBER','CLIENT']), (21, 7, 'CLIENT', NULL),
      (22, 8, 'CLIENT', NULL), (23, 7, 'BROKER', ARRAY['BROKER']);
    ${table('111_transaction_receipt_history.js', 'transaction_receipts')};
    ${table('111_transaction_receipt_history.js', 'transaction_receipt_prints')};
    ${table('103_audit_logs.js', 'audit_logs')};`);
  const query = sql.query.bind(sql);
  const { query: oldQuery, connect: oldConnect } = pool;
  pool.query = query;
  pool.connect = async () => ({ query, release() {} });
  t.after(() => { pool.query = oldQuery; pool.connect = oldConnect; });

  const request = request_id => invoke(recordClientAppInvitePrint, { body: { request_id } });
  assert.deepEqual(await invoke(getClientAppInvitePrintCount), { code: 200, data: { print_count: 0 } });
  const first = '00000000-0000-4000-8000-000000000001';
  const second = '00000000-0000-4000-8000-000000000002';
  assert.deepEqual(await request(first), { code: 201, data: { print_count: 1 } });
  assert.deepEqual(await request(second), { code: 201, data: { print_count: 2 } });
  assert.deepEqual(await request(first), { code: 200, data: { print_count: 2 } });
  assert.deepEqual(await invoke(getClientAppInvitePrintCount), { code: 200, data: { print_count: 2 } });
  assert.deepEqual((await invoke(getClientAppInvitePrintCount, { params: { id: '21' } })).data, { print_count: 0 });
  assert.equal((await invoke(getClientAppInvitePrintCount, { params: { id: '22' }, query: { site_id: '8' } })).code, 403);
  assert.equal((await invoke(getClientAppInvitePrintCount, { query: { site_id: '9' } })).code, 403);
  assert.equal((await invoke(getClientAppInvitePrintCount, { params: { id: '22' } })).code, 404);
  assert.equal((await invoke(getClientAppInvitePrintCount, { params: { id: '23' } })).code, 404);
  assert.equal((await request('invalid')).code, 400);
  assert.equal((await invoke(recordReceiptPrint, { body: { module: 'member_app_invite', record_id: '20' } })).code, 404);
  assert.equal((await invoke(getReceiptHistory, { params: { module: 'member_app_invite', recordId: '20' } })).code, 404);
  const { rows } = await sql.query("SELECT action, event_type, entity_id, amount FROM audit_logs ORDER BY id");
  assert.deepEqual(rows, Array.from({ length: 2 }, () => ({ action: 'PRINT', event_type: 'APP_INVITE', entity_id: '20', amount: null })));
});
