import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pool from '../src/config/db.js';
import permissionModel from '../src/models/Permission.model.js';
import {
  transferEntry,
  executeTransfer,
  handleTransferError,
} from '../src/controllers/transactionTransfer.controller.js';
import { versionOf } from '../src/services/transactionTransfer.validation.js';
const user = { id: 1, role: 'admin' };
const original = (id) => ({
  id,
  site_id: 5,
  date: '2026-09-05',
  credit: '100',
  debit: '0',
  particular: 'Client',
  payment_mode: 'CASH',
  created_by: 1,
  status: 'approved',
  row_version: '7',
});
function fixture({
  failInsert = 0,
  linked = false,
  stale = false,
  site = 5,
} = {}) {
  let records = new Map([
      [1, original(1)],
      [2, { ...original(2), site_id: site }],
    ]),
    destinations = [],
    audit = [],
    batches = new Map(),
    snapshot;
  const log = [];
  const db = {
    release() {},
    async query(sql, args = []) {
      log.push(sql);
      if (sql === 'BEGIN') {
        snapshot = structuredClone({ records, destinations, audit, batches });
        return { rows: [] };
      }
      if (sql === 'ROLLBACK') {
        ({ records, destinations, audit, batches } = snapshot);
        return { rows: [] };
      }
      if (sql === 'COMMIT' || sql.startsWith('SET LOCAL')) return { rows: [] };
      if (sql.startsWith('INSERT INTO transaction_transfer_batches')) {
        if (!batches.has(args[0]))
          batches.set(args[0], {
            request_id: args[0],
            request_hash: args[1],
            transferred_by: args[2],
          });
        return { rows: [] };
      }
      if (sql.startsWith('SELECT * FROM transaction_transfer_batches'))
        return { rows: [structuredClone(batches.get(args[0]))] };
      if (sql.startsWith('UPDATE transaction_transfer_batches')) {
        batches.get(args[0]).response = args[1];
        return { rows: [] };
      }
      if (sql.includes('FROM expenses owner_row')) {
        let row = records.get(args[0]);
        return { rows: row ? [stale ? { ...row, credit: '101' } : row] : [] };
      }
      if (sql.includes('FROM compliance_finance_links'))
        return { rows: linked ? [{ id: 1 }] : [] };
      if (sql.includes('FROM cash_flow_entries WHERE source_module'))
        return { rows: [] };
      if (sql.includes('FROM bank_reconciliation_links')) return { rows: [] };
      if (sql.includes('FROM misc_income_categories'))
        return { rows: [{ id: 3, name: 'Other' }] };
      if (sql.startsWith('DELETE FROM expenses')) {
        records.delete(args[0]);
        return { rows: [] };
      }
      if (sql.startsWith('INSERT INTO misc_income_entries')) {
        if (failInsert && destinations.length + 1 === failInsert)
          throw Object.assign(new Error('destination check failed'), {
            code: '23514',
          });
        const columns = sql.match(/\(([^)]+)\) VALUES/)[1].split(',');
        const row = {
          id: 100 + destinations.length,
          ...Object.fromEntries(columns.map((k, i) => [k, args[i]])),
        };
        destinations.push(row);
        return { rows: [row] };
      }
      if (sql.startsWith('INSERT INTO transaction_entry_transfers')) {
        audit.push(args);
        return { rows: [{ id: audit.length, created_at: '2026-09-05' }] };
      }
      throw new Error('Unexpected query: ' + sql);
    },
  };
  return { db, log, state: () => ({ records, destinations, audit, batches }) };
}
const request = (entries = [1, 2]) => ({
  user,
  body: {
    request_id: randomUUID(),
    target_type: 'misc_income',
    target_id: 3,
    reason: 'Correct module classification',
    entries: entries.map((id) => ({
      source_type: 'expense',
      source_id: id,
      source_version: versionOf({ row: original(id), mirror: {} }),
      edits: { amount: 150 },
    })),
  },
});
async function invoke(f, req) {
  const connect = pool.connect;
  pool.connect = async () => f.db;
  try {
    return await new Promise((resolve, reject) =>
      transferEntry(
        req,
        {
          status(code) {
            this.code = code;
            return this;
          },
          json(body) {
            resolve({ code: this.code, body });
          },
        },
        reject,
      ),
    );
  } finally {
    pool.connect = connect;
  }
}
test('bulk transfer creates every destination and audit with edited fields', async () => {
  const f = fixture();
  const res = await invoke(f, request());
  assert.equal(res.code, 201);
  assert.equal(res.body.transfers.length, 2);
  assert.equal(f.state().records.size, 0);
  assert.equal(f.state().destinations.length, 2);
  assert.equal(f.state().destinations[0].amount, 150);
  assert.equal(f.state().destinations[0].status, 'pending');
  assert.equal(f.state().audit.length, 2);
  assert.equal(f.state().audit[0][13].credit, '100');
  assert.ok(
    f.log.indexOf('COMMIT') >
      f.log.findIndex((s) =>
        s.startsWith('INSERT INTO transaction_entry_transfers'),
      ),
  );
});
test('failure in the second destination restores both sources and removes all partial writes', async () => {
  const f = fixture({ failInsert: 2 });
  await assert.rejects(invoke(f, request()), /destination check failed/);
  assert.equal(f.state().records.size, 2);
  assert.equal(f.state().destinations.length, 0);
  assert.equal(f.state().audit.length, 0);
  assert.ok(f.log.includes('ROLLBACK'));
  assert.ok(!f.log.includes('COMMIT'));
});
test('an identical retry returns the committed response without a second move', async () => {
  const f = fixture(),
    req = request();
  const first = await invoke(f, req),
    second = await invoke(f, req);
  assert.equal(first.code, 201);
  assert.equal(second.code, 200);
  assert.deepEqual(first.body, second.body);
  assert.equal(f.state().audit.length, 2);
  req.body.reason = 'Different request contents';
  await assert.rejects(invoke(f, req), /different transfer/);
  assert.equal(f.state().audit.length, 2);
});
test('stale, linked, same-destination and invalid selected entries never delete a source', async () => {
  for (const config of [{ stale: true }, { linked: true }]) {
    const f = fixture(config);
    await assert.rejects(invoke(f, request()));
    assert.equal(f.state().records.size, 2);
    assert.ok(!f.log.some((s) => s.startsWith('DELETE')));
  }
  const f = fixture(),
    req = request();
  req.body.target_type = 'expense';
  await assert.rejects(invoke(f, req), /different module/);
  assert.ok(!f.log.some((s) => s.startsWith('DELETE')));
});
test('batch rejects mixed sites before any source deletion', async () => {
  const f = fixture({ site: 6 }),
    req = request();
  req.body.entries[1].source_version = versionOf({
    row: { ...original(2), site_id: 6 },
    mirror: {},
  });
  await assert.rejects(invoke(f, req), /one site/);
  assert.ok(!f.log.some((s) => s.startsWith('DELETE')));
});
test('source and destination permissions are enforced before accessing data', async () => {
  const get = permissionModel.getPermission;
  permissionModel.getPermission = async () => ({
    can_write: false,
    can_delete: false,
  });
  try {
    const f = fixture(),
      req = request();
    req.user = { id: 2, role: 'sub_admin' };
    await assert.rejects(executeTransfer(f.db, req), /permission/);
    assert.equal(f.log.length, 0);
  } finally {
    permissionModel.getPermission = get;
  }
});
test.after(() => pool.end());

test('a retry waiting on the same request keeps its outcome unknown', async () => {
  const f = fixture();
  const query = f.db.query;
  f.db.query = async (sql, args) => {
    if (sql.startsWith('INSERT INTO transaction_transfer_batches')) {
      throw Object.assign(new Error('lock timeout'), { code: '55P03' });
    }
    return query(sql, args);
  };
  let caught;
  try {
    await invoke(f, request());
  } catch (error) {
    caught = error;
  }
  assert.equal(caught.transferUnknown, true);
  let response;
  handleTransferError(
    caught,
    {},
    {
      status(code) {
        assert.equal(code, 409);
        return this;
      },
      json(body) {
        response = body;
      },
    },
    () => assert.fail('must handle uncertain retry'),
  );
  assert.equal(response.transfer_state, 'unknown');
  assert.equal(f.state().records.size, 2);
});
