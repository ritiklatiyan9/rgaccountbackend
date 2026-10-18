import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PGlite } from '@electric-sql/pglite';
import pool from '../src/config/db.js';
import { documentationSchemaSql } from '../src/migrations/218_transaction_documentation.js';
import { DOCUMENTATION_TARGETS, documentationRecord, readDocumentation, saveDocumentation, listDocumentationGaps, readDocumentationBatch, validateDocumentationDraft, enrichTransactionDocumentation } from '../src/services/transactionDocumentation.service.js';
import { putDocumentationPolicy, getDocumentationDefaults } from '../src/controllers/transactionDocumentation.controller.js';
import { createRequestTransaction, installRequestTransactionAdapter, requestTransactionContext } from '../src/services/requestTransactionContext.js';
import { createTransactionDocumentationMiddleware } from '../src/middlewares/transactionDocumentation.middleware.js';
import { expenseModel } from '../src/models/Expense.model.js';
import { approveEditRequest } from '../src/controllers/editRequest.controller.js';
const admin = {
  id: 1,
  name: 'Admin',
  role: 'admin',
  organization_id: 1
};
const sub = {
  id: 2,
  name: 'Maker',
  role: 'sub_admin',
  organization_id: 1
};
async function fixture(t) {
  const pg = new PGlite(),
    query = (sql, params) => pg.query(sql, params);
  const db = {
    query,
    connect: async () => ({
      query,
      release() {}
    })
  };
  const oldQuery = pool.query,
    oldConnect = pool.connect;
  pool.query = query;
  pool.connect = db.connect;
  t.after(async () => {
    pool.query = oldQuery;
    pool.connect = oldConnect;
    await pg.close();
  });
  await pg.exec(`CREATE TABLE sites(id integer PRIMARY KEY,name text,organization_id integer);
    INSERT INTO sites VALUES(5,'OM',1),(7,'Other',1),(8,'Other organization',2);
    CREATE TABLE user_sites(user_id integer,site_id integer);INSERT INTO user_sites VALUES(2,5);
    CREATE TABLE user_permissions(id serial,user_id integer,module text,can_read boolean,can_write boolean,can_update boolean,can_delete boolean,can_view_all boolean);
    INSERT INTO user_permissions(user_id,module,can_read,can_write,can_update,can_view_all) VALUES(2,'expenses',true,true,false,false);
    CREATE TABLE farmers(id integer,site_id integer);INSERT INTO farmers VALUES(1,5);
    CREATE TABLE plots(id integer,site_id integer);INSERT INTO plots VALUES(1,5);`);
  for (const {
    table
  } of Object.values(DOCUMENTATION_TARGETS)) await pg.exec(`CREATE TABLE ${table}(
    id serial PRIMARY KEY,site_id integer DEFAULT 5,created_by integer DEFAULT 2,date date DEFAULT '2026-10-18',payment_date date DEFAULT '2026-10-18',
    status text DEFAULT 'approved',amount numeric DEFAULT 100,debit numeric DEFAULT 100,credit numeric DEFAULT 0,payment_mode text DEFAULT 'CASH',
    voucher_url text,bill_url text,voucher_urls text[],bill_urls text[],voucher_gap_filled_at timestamptz,
    transaction_type text,entry_type text,source_module text,source_plot_payment_id integer,source_vendor_payment_id integer,
    expense_id integer,farmer_payment_id integer,commission_id integer,cash_flow_entry_id integer,firm_transaction_id integer,plot_payment_id integer,
    vendor_payment_id integer,registry_payment_id integer,vendor_inventory_payment_id integer,misc_income_entry_id integer,land_deal_payment_id integer,
    farmer_id integer DEFAULT 1,plot_id integer DEFAULT 1,to_entity text DEFAULT 'Party',is_firm_to_firm_transfer boolean DEFAULT false);`);
  await pg.exec(documentationSchemaSql);
  const insert = async (source = 'expense', values = {}) => {
    const keys = Object.keys(values),
      params = Object.values(values);
    return (await db.query(`INSERT INTO ${DOCUMENTATION_TARGETS[source].table} ${keys.length ? `(${keys.join(',')}) VALUES(${keys.map((_, i) => `$${i + 1}`).join(',')})` : 'DEFAULT VALUES'} RETURNING *`, params)).rows[0];
  };
  const read = async (source, id, user = admin) => readDocumentation(await documentationRecord(user, source, id, db), user, db, {
    history: true
  });
  const save = async (source, id, draft, user = admin) => {
    await db.query('BEGIN');
    try {
      const result = await saveDocumentation(user, source, id, draft, db);
      await db.query('COMMIT');
      return result;
    } catch (error) {
      await db.query('ROLLBACK');
      throw error;
    }
  };
  return {
    pg,
    db,
    insert,
    read,
    save
  };
}
const invoke = (handler, req) => new Promise((resolve, reject) => handler(req, {
  statusCode: 200,
  status(code) {
    this.statusCode = code;
    return this;
  },
  json(body) {
    resolve({
      status: this.statusCode,
      ...body
    });
  }
}, reject));
test('independent requirements cover all four states, upload/removal and stale versions without financial UPDATE', async t => {
  const {
    pg,
    insert,
    save,
    read,
    db
  } = await fixture(t);
  const row = await insert();
  await pg.exec(`CREATE FUNCTION forbid_financial_updates() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'Financial UPDATE forbidden'; END$$;
    CREATE TRIGGER no_updates BEFORE UPDATE ON expenses FOR EACH ROW EXECUTE FUNCTION forbid_financial_updates();`);
  const initial = await read('expense', row.id);
  assert.equal(initial.status, 'missing_voucher');
  assert.equal(initial.bill_required, false);
  let state = await save('expense', row.id, {
    version: 0,
    bill_required: true,
    voucher_required: true
  });
  assert.equal(state.status, 'missing_both');
  state = await save('expense', row.id, {
    version: 1,
    voucher_required: false
  });
  assert.equal(state.status, 'missing_bill');
  state = await save('expense', row.id, {
    version: 2,
    bill_required: false,
    voucher_required: true
  });
  assert.equal(state.status, 'missing_voucher');
  state = await save('expense', row.id, {
    version: 3,
    voucher_required: false,
    reason: 'Internal adjustment'
  });
  assert.equal(state.status, 'not_required');
  state = await save('expense', row.id, {
    version: 4,
    bill_required: true,
    documents: [{
      kind: 'bill',
      url: 'https://example.test/bill.pdf'
    }]
  });
  assert.equal(state.status, 'complete');
  state = await save('expense', row.id, {
    version: 5,
    voucher_required: true
  });
  assert.equal(state.status, 'missing_voucher', 'a bill never counts as a voucher');
  state = await save('expense', row.id, {
    version: 6,
    documents: [{
      kind: 'bill',
      url: 'https://example.test/bill.pdf'
    }, {
      kind: 'voucher',
      url: 'https://example.test/voucher.pdf'
    }]
  });
  assert.equal(state.status, 'complete');
  state = await save('expense', row.id, {
    version: 7,
    documents: []
  });
  assert.equal(state.status, 'missing_both');
  await assert.rejects(save('expense', row.id, {
    version: 7,
    bill_required: false
  }), error => error.statusCode === 409 && error.code === 'DOCUMENTATION_CONFLICT');
  const detail = await read('expense', row.id);
  assert.equal(detail.version, 8);
  assert.equal(detail.history.length, 8);
  assert.equal(detail.history.find(row => row.changes.after.version === 4).changes.after.bill_required, false);
  assert.deepEqual((await db.query('SELECT * FROM expenses WHERE id=$1', [row.id])).rows[0], row);
});
test('legacy baselines, valid multiple attachments, noncash bills and existing attachments remain safe', async t => {
  const {
    insert,
    read,
    save
  } = await fixture(t);
  const reviewed = await insert('expense', {
    voucher_gap_filled_at: '2026-01-01'
  });
  assert.equal((await read('expense', reviewed.id)).status, 'not_required');
  const bank = await insert('expense', {
    payment_mode: 'bank',
    bill_urls: ['', 'https://example.test/b.pdf']
  });
  assert.equal((await read('expense', bank.id)).status, 'complete');
  const cash = await insert('expense', {
    bill_url: 'https://example.test/only-bill.pdf',
    voucher_url: '  '
  });
  assert.equal((await read('expense', cash.id)).status, 'missing_voucher');
  const changed = await save('expense', cash.id, {
    version: 0,
    voucher_required: false,
    documents: []
  });
  assert.equal(changed.documents.length, 1);
  assert.equal(changed.documents[0].origin, 'legacy');
  const bad = await insert('expense', {
    voucher_url: 'javascript:alert(1)'
  });
  assert.equal((await read('expense', bad.id)).status, 'missing_voucher');
});
test('all native modules aggregate approved/pending gaps once and accounting mirrors are excluded', async t => {
  const {
    insert,
    save,
    db
  } = await fixture(t);
  for (const source of Object.keys(DOCUMENTATION_TARGETS)) await insert(source, {
    status: source === 'expense' ? 'pending' : 'approved'
  });
  await insert('daybook', {
    expense_id: 1
  });
  await insert('cash_flow_entry', {
    source_module: 'expense'
  });
  await insert('plot_registry_payment', {
    source_plot_payment_id: 1
  });
  await insert('vendor_inventory_payment', {
    source_vendor_payment_id: 1
  });
  let gaps = await listDocumentationGaps(admin, {
    site_id: 5
  }, db);
  assert.equal(gaps.length, Object.keys(DOCUMENTATION_TARGETS).length);
  assert.equal(new Set(gaps.map(row => `${row.source}:${row.id}`)).size, gaps.length);
  await save('expense', 1, {
    version: 0,
    voucher_required: false
  });
  gaps = await listDocumentationGaps(admin, {
    site_id: 5
  }, db);
  assert.equal(gaps.length, Object.keys(DOCUMENTATION_TARGETS).length - 1);
  await insert('expense', {
    status: 'rejected'
  });
  assert.equal((await listDocumentationGaps(admin, {
    site_id: 5
  }, db)).length, gaps.length);
  const entries = [{
    source: 'expense',
    id: 1,
    site_id: 5,
    payment_mode: 'CASH'
  }];
  await enrichTransactionDocumentation(entries, admin, db);
  assert.equal(entries[0].documentation.status, 'not_required');
  const mirror = [{
    source: 'daybook_expense',
    id: 2,
    site_id: 5,
    expense_id: 1,
    payment_mode: 'CASH'
  }];
  await enrichTransactionDocumentation(mirror, admin, db);
  assert.equal(mirror[0].documentation.status, 'not_required', 'an approval mirror follows the native override');
  assert.equal(mirror[0].documentation.source, 'expense');
  const batch = await readDocumentationBatch(admin, [{
    source: 'expense',
    id: 1
  }, {
    source: 'cashflow_entry',
    id: 1
  }], db);
  assert.equal(Object.keys(batch).length, 2);
  assert.equal(batch['cash_flow_entry:1'].source, 'cash_flow_entry');
});
test('permissions, site/organization boundaries, admin policies and mandatory locks fail closed', async t => {
  const {
      insert,
      read,
      save,
      db
    } = await fixture(t),
    own = await insert(),
    other = await insert('expense', {
      created_by: 3
    }),
    site = await insert('expense', {
      site_id: 7
    }),
    org = await insert('expense', {
      site_id: 8
    });
  assert.equal((await read('expense', own.id, sub)).can_edit, false);
  await assert.rejects(save('expense', own.id, {
    version: 0,
    voucher_required: false
  }, sub), error => error.statusCode === 403);
  for (const id of [other.id, site.id]) await assert.rejects(read('expense', id, sub), error => error.statusCode === 403);
  await assert.rejects(read('expense', org.id), error => error.statusCode === 404);
  const body = {
    site_id: 5,
    version: 0,
    bill_required: true,
    voucher_required: false,
    bill_locked: true
  };
  await assert.rejects(invoke(putDocumentationPolicy, {
    user: sub,
    params: {
      source: 'expense'
    },
    body
  }), error => error.statusCode === 403);
  const policy = await invoke(putDocumentationPolicy, {
    user: admin,
    params: {
      source: 'expense'
    },
    body
  });
  assert.equal(policy.policy.version, 1);
  const state = await read('expense', own.id);
  assert.equal(state.locked.bill, true);
  assert.equal(state.bill_required, true);
  assert.equal(state.voucher_required, false);
  await assert.rejects(save('expense', own.id, {
    version: 0,
    bill_required: false
  }), error => error.code === 'DOCUMENTATION_POLICY_LOCKED');
  const specific = await invoke(putDocumentationPolicy, {
    user: admin,
    params: {
      source: 'expense'
    },
    body: {
      ...body,
      transaction_type: 'credit',
      bill_required: false,
      bill_locked: false
    }
  });
  assert.equal(specific.policy.transaction_type, 'credit');
  const defaults = await invoke(getDocumentationDefaults, {
    user: admin,
    query: {
      source: 'expense',
      site_id: 5,
      direction: 'credit',
      payment_mode: 'BANK'
    }
  });
  assert.equal(defaults.documentation.bill_required, true);
  assert.equal(defaults.documentation.version, 0);
  await assert.rejects(invoke(putDocumentationPolicy, {
    user: admin,
    params: {
      source: 'expense'
    },
    body
  }), error => error.statusCode === 409);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM transaction_documentation_history WHERE event_type='policy'")).rows[0].n, 2);
});
test('draft validation rejects malformed booleans, versions, unsafe URLs and mixed document types', () => {
  for (const body of [{
    bill_required: 'false'
  }, {
    version: -1
  }, {
    version: '1'
  }, {
    documents: [{
      kind: 'bill',
      url: 'javascript:bad'
    }]
  }, {
    documents: [{
      kind: 'receipt',
      url: 'https://example.test/a'
    }]
  }]) assert.throws(() => validateDocumentationDraft(body));
});
test('gap counts track every confirmed requirement and document transition', async t => {
  const {
    insert,
    save,
    db
  } = await fixture(t);
  const row = await insert();
  let version = 0;
  const steps = [[{
    bill_required: true,
    voucher_required: true
  }, [1, 1]], [{
    voucher_required: false
  }, [1, 0]], [{
    bill_required: false,
    voucher_required: true
  }, [0, 1]], [{
    voucher_required: false
  }, [0, 0]], [{
    bill_required: true,
    voucher_required: true,
    documents: [{
      kind: 'bill',
      url: 'https://example.test/bill.pdf'
    }]
  }, [0, 1]], [{
    documents: [{
      kind: 'bill',
      url: 'https://example.test/bill.pdf'
    }, {
      kind: 'voucher',
      url: 'https://example.test/voucher.pdf'
    }]
  }, [0, 0]], [{
    documents: []
  }, [1, 1]]];
  for (const [draft, expected] of steps) {
    const saved = await save('expense', row.id, {
      version: version++,
      ...draft
    });
    assert.equal(saved.history.length, version, 'successful saves return the updated audit history');
    const gaps = await listDocumentationGaps(admin, {
      site_id: 5
    }, db);
    assert.deepEqual([gaps.filter(item => item.documentation.missing_bill).length, gaps.filter(item => item.documentation.missing_voucher).length], expected);
    assert.equal(gaps.length, expected.some(Boolean) ? 1 : 0);
  }
});
test('expense missing-bill rows, totals and breakdowns use the saved native policy and attachment state', async t => {
  const {
    pg,
    db,
    insert,
    save
  } = await fixture(t);
  await pg.exec(`CREATE FUNCTION financial_transaction_posts(text,text,text,text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$SELECT $2='approved'$$;
    CREATE TABLE users(id integer,name text,email text);
    CREATE TABLE members(id integer,full_name text,site_id integer,phone text);
    CREATE TABLE plot_commissions_v2(id integer,plot_id integer,agent_id integer);
    CREATE TABLE vendor_commitments(id integer,vendor_name text);
    CREATE TABLE cash_flow_months(id integer,ledger_type text);
    CREATE TABLE transaction_party_links(source_key text,source_id integer,site_id integer,member_id integer,direction text);
    ALTER TABLE farmers ADD COLUMN name text;
    ALTER TABLE plots ADD COLUMN plot_no text;`);
  const extraColumns = {
    from_entity: 'text',
    remark: 'text',
    account_no: 'text',
    branch: 'text',
    category: 'text',
    sub_category: 'text',
    cheque_status: 'text',
    cheque_no: 'text',
    approved_by: 'integer',
    approved_at: 'timestamptz',
    created_at: 'timestamptz DEFAULT now()',
    updated_at: 'timestamptz DEFAULT now()',
    assigned_user_id: 'integer',
    assigned_admin_id: 'integer',
    customer_signature_url: 'text',
    authority_signature_url: 'text',
    display_order: 'integer',
    transaction_time: 'time',
    entry_transfer_id: 'text',
    entry_transfer_role: 'text',
    tds_amount: 'numeric DEFAULT 0',
    tds_rate: 'numeric',
    tds_mode: 'text',
    tds_section: 'text',
    tds_module: 'text',
    tds_deductee_name: 'text',
    tds_pan: 'text',
    bank_account_no: 'text',
    bank_ifsc: 'text',
    remarks: 'text',
    plot_commission_id: 'integer',
    commitment_id: 'integer',
    note: 'text',
    cash_flow_month_id: 'integer',
    to_name: 'text',
    particular: 'text',
    cash_type: 'text'
  };
  for (const {
    table
  } of Object.values(DOCUMENTATION_TARGETS)) {
    await pg.exec(`ALTER TABLE ${table} ${Object.entries(extraColumns).map(([name, type]) => `ADD COLUMN IF NOT EXISTS ${name} ${type}`).join(',')}`);
  }
  const typed = await insert('expense', {
    transaction_type: 'supplier',
    category: 'Office'
  });
  const exempt = await insert('expense', {
    payment_mode: 'BANK',
    category: 'Office'
  });
  await insert('expense', {
    payment_mode: 'BANK',
    bill_urls: ['https://example.test/old-bill.pdf'],
    category: 'Office'
  });
  const override = await insert('expense', {
    category: 'Office'
  });
  await invoke(putDocumentationPolicy, {
    user: admin,
    params: {
      source: 'expense'
    },
    body: {
      site_id: 5,
      transaction_type: 'supplier',
      version: 0,
      bill_required: true,
      voucher_required: false
    }
  });
  await save('expense', exempt.id, {
    version: 0,
    bill_required: false
  });
  await save('expense', override.id, {
    version: 0,
    bill_required: true
  });
  const filters = {
    missing_bill: 'true'
  };
  const page = await expenseModel.findPaginatedUnified(5, filters, 1, 20, db);
  assert.deepEqual(page.items.map(row => Number(row.id)).sort(), [typed.id, override.id]);
  assert.equal(page.totalItems, 2);
  assert.equal(Number(page.summary.total_debit), 200);
  assert.equal(page.items.some(row => Object.hasOwn(row, 'documentation_record')), false, 'raw evidence context stays out of list responses');
  for (const only_site of ['true', 'false']) {
    const breakdown = await expenseModel.getUnifiedBreakdowns(5, {
      ...filters,
      only_site
    }, db);
    assert.equal(breakdown.modeBreakdown.reduce((sum, row) => sum + row.entries, 0), 2);
    assert.equal(breakdown.categoryBreakdown.reduce((sum, row) => sum + row.entries, 0), 2);
  }
  await save('expense', typed.id, {
    version: 0,
    documents: [{
      kind: 'bill',
      url: 'https://example.test/new-bill.pdf'
    }]
  });
  assert.equal((await expenseModel.findPaginatedUnified(5, filters, 1, 20, db)).totalItems, 1);
});

test('edit-request approval applies documentation atomically and rolls financial edits back on a stale version', async t => {
  const { pg, db, insert, read } = await fixture(t);
  await pg.exec(`CREATE TABLE users(id integer PRIMARY KEY,name text,role text,is_active boolean,organization_id integer);
    INSERT INTO users VALUES(1,'Admin','admin',true,1),(2,'Maker','sub_admin',true,1);
    UPDATE user_permissions SET can_update=true WHERE user_id=2 AND module='expenses';
    INSERT INTO user_permissions(user_id,module,can_read,can_write,can_update,can_view_all) VALUES(2,'daybook',true,false,false,false);
    ALTER TABLE expenses ADD COLUMN transaction_time time;
    CREATE TABLE edit_requests(id serial PRIMARY KEY,requested_by integer,site_id integer,module text,record_id integer,
      proposed_data jsonb,status text DEFAULT 'pending',reviewed_by integer,reviewed_at timestamptz,updated_at timestamptz);`);
  const row = await insert();
  const request = async (debit,version) => (await db.query(`INSERT INTO edit_requests(requested_by,site_id,module,record_id,proposed_data)
    VALUES(2,5,'daybook_expense',$1,$2::jsonb) RETURNING id`,[row.id,JSON.stringify({debit,documentation:{source:'expense',version,bill_required:true,voucher_required:false}})])).rows[0].id;
  const first = await invoke(approveEditRequest,{params:{id:await request(220,0)},user:admin,body:{}});
  assert.equal(first.status,200);assert.equal((await read('expense',row.id)).version,1);
  const staleId = await request(440,0);
  const conflict = await invoke(approveEditRequest,{params:{id:staleId},user:admin,body:{}});
  assert.equal(conflict.status,409);
  assert.equal(Number((await db.query('SELECT debit FROM expenses WHERE id=$1',[row.id])).rows[0].debit),220);
  assert.equal((await db.query('SELECT status FROM edit_requests WHERE id=$1',[staleId])).rows[0].status,'pending');
  assert.equal((await read('expense',row.id)).history.length,1);
  await db.query("UPDATE user_permissions SET can_update=false WHERE user_id=2 AND module='expenses'");
  await assert.rejects(invoke(approveEditRequest,{params:{id:staleId},user:admin,body:{}}),error=>error.statusCode===403);
  assert.equal(Number((await db.query('SELECT debit FROM expenses WHERE id=$1',[row.id])).rows[0].debit),220);
});
test('opt-in context commits nested financial creation and metadata together; metadata failure rolls everything back', async t => {
  const {
    pg,
    db
  } = await fixture(t);
  const connect = async () => ({
    query: (sql, params) => pg.query(sql, params),
    release() {}
  });
  const adapted = {
    query: db.query,
    connect
  };
  installRequestTransactionAdapter(adapted);
  const middleware = createTransactionDocumentationMiddleware({
    database: adapted,
    connect
  });
  const perform = (draft, write) => new Promise((resolve, reject) => {
    const req = {
      method: 'POST',
      path: '/expenses',
      body: {},
      user: admin,
      get: () => JSON.stringify({
        source: 'expense',
        version: 0,
        ...draft
      })
    };
    const res = Object.assign(new EventEmitter(), {
      statusCode: 201,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(body) {
        assert.equal(requestTransactionContext.getStore(), null, 'response audit work runs outside the committed transaction');
        resolve({
          status: this.statusCode,
          ...body
        });
        return this;
      }
    });
    middleware(req, res, () => void write(adapted).then(row => res.json({
      expense: row
    }), reject));
  });
  const write = async database => {
    const client = await database.connect();
    await client.query('BEGIN');
    const row = (await client.query('INSERT INTO expenses DEFAULT VALUES RETURNING *')).rows[0];
    await client.query('COMMIT');
    client.release();
    return row;
  };
  const success = await perform({
    bill_required: true,
    voucher_required: false
  }, write);
  assert.equal(success.status, 201);
  assert.equal(success.documentation.status, 'missing_bill');
  assert.equal((await db.query('SELECT count(*)::int AS n FROM expenses')).rows[0].n, 1);
  const cteSuccess = await perform({
    bill_required: false,
    voucher_required: false
  }, async database => (await database.query('WITH new_payment AS (INSERT INTO expenses DEFAULT VALUES RETURNING *) SELECT row_to_json(new_payment) AS payment FROM new_payment')).rows[0].payment);
  assert.equal(cteSuccess.status, 201);
  assert.equal(cteSuccess.documentation.status, 'not_required');
  await pg.exec(`CREATE FUNCTION fail_documentation_write() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'Simulated metadata failure'; END$$;
    CREATE TRIGGER fail_save BEFORE INSERT ON transaction_documentation FOR EACH ROW EXECUTE FUNCTION fail_documentation_write();`);
  const failure = await perform({
    bill_required: true
  }, write);
  assert.equal(failure.status, 500);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM expenses')).rows[0].n, 2, 'failed metadata must roll back the financial INSERT even after nested COMMIT');
});
test('request transactions preserve ordinary query behavior and nested rollback uses savepoints', async () => {
  const calls = [],
    db = {
      query: async sql => {
        calls.push(sql);
        return {
          rows: []
        };
      },
      connect: async () => ({
        query: async sql => {
          calls.push(sql);
          return {
            rows: []
          };
        },
        release() {
          calls.push('release');
        }
      })
    };
  const {
    originalConnect
  } = installRequestTransactionAdapter(db);
  await db.query('ordinary');
  assert.deepEqual(calls, ['ordinary']);
  const transaction = createRequestTransaction({
    connect: originalConnect
  });
  await requestTransactionContext.run(transaction, async () => {
    const nested = await db.connect();
    await nested.query('BEGIN');
    await nested.query('SELECT 1');
    await nested.query('ROLLBACK');
    nested.release();
    await db.query('SELECT 2');
  });
  await transaction.finish(true);
  await requestTransactionContext.run(transaction, async () => {
    await assert.rejects(db.query('late write'), /ended/);
    await assert.rejects(db.connect(), /ended/);
  });
  assert.deepEqual(calls, ['ordinary', 'BEGIN', 'SAVEPOINT documentation_nested_1', 'SELECT 1', 'ROLLBACK TO SAVEPOINT documentation_nested_1', 'RELEASE SAVEPOINT documentation_nested_1', 'SELECT 2', 'COMMIT', 'release']);
});

test('stale headers cannot reach approval notifications and multipart edit drafts wait for upload parsing', () => {
  const middleware = createTransactionDocumentationMiddleware({connect:async()=>{throw new Error('Unexpected checkout');}});
  const draft = {source:'expense',version:0,bill_required:false,voucher_required:false};
  let nextCalled = false, response;
  const res = {status(code){this.statusCode=code;return this;},json(body){response=body;return this;}};
  middleware({method:'PUT',path:'/approvals/1/approve',get:()=>JSON.stringify(draft)},res,()=>{nextCalled=true;});
  assert.equal(res.statusCode,400);assert.equal(nextCalled,false);assert.match(response.message,/native financial transaction/);
  const multipart = {method:'POST',path:'/edit-requests',get:()=>JSON.stringify(draft)};
  middleware(multipart,res,()=>{nextCalled=true;});
  assert.equal(nextCalled,true);assert.deepEqual(multipart.transactionDocumentationDraft,draft);
  assert.equal(multipart.body,undefined,'the global middleware does not parse or reject multipart fields before Multer');
});
