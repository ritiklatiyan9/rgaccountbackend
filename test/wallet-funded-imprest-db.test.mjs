import test from 'node:test';
import assert from 'node:assert/strict';
import pool from '../src/config/db.js';
import { dayBookModel } from '../src/models/DayBook.model.js';
import { walletBalanceGuardsSql } from '../src/migrations/210_wallet_balance_guards.js';
import { installPermanentWalletGuards } from '../src/migrations/212_wallet_permanent_balance_guard.js';
import { up } from '../src/migrations/213_wallet_funded_imprest.js';
import { up as legacyGuards } from '../src/migrations/195_imprest_cash_funding_guard.js';
import { getSiteImprestWallet, postImprestWalletMovement } from '../src/services/imprestWallet.service.js';
import { getAccessibleSiteBalances, getCashWalletSiteBalanceDetail } from '../src/graphql/services/kpi.service.js';
import { createAllocation, confirmReceipt, cancelAllocation, declineReceipt, getBalance, getSiteBalance, acceptReturn, adjustBalance, createTransfer } from '../src/controllers/imprest.controller.js';

const invoke = (handler, body = {}, extra = {}) => new Promise((resolve, reject) => {
  let status = 200;
  handler({ body, params: {}, query: { site_id: 10 }, imprestSiteId: 10,
    user: { id: 7, name: 'Kuldeep Tomar', role: 'admin' },
    imprestParticipants: { sub_admin_id: { role: 'sub_admin' }, user_id: { role: 'sub_admin' } }, ...extra },
  { status(value) { status = value; return this; }, json(data) { resolve({ status, data }); } }, reject);
});

test('site cash = Kuldeep wallet; imprest issues debit once and returns restore cash', { skip: !process.env.PGLITE_MODULE }, async t => {
  const { PGlite } = await import(process.env.PGLITE_MODULE);
  const pg = new PGlite();
  const query = async (sql, args) => {
    const result = args?.length ? await pg.query(sql, args) : (await pg.exec(sql)).at(-1);
    return { ...result, rows: result?.rows || [], rowCount: result?.affectedRows ?? result?.rows?.length ?? 0 };
  };
  const db = { query, connect: async () => ({ query, release() {} }) };
  const scalar = async sql => Number(Object.values((await query(sql)).rows[0])[0]);
  const cash = async () => (await getSiteImprestWallet(10, db)).balance;
  const staff = () => scalar('SELECT COALESCE(sum(amount),0) FROM imprest_ledger WHERE user_id=2 AND site_id=10');
  const issue = amount => invoke(createAllocation, { sub_admin_id: 2, amount, site_id: 10 });
  const receiver = { user: { id: 2, role: 'sub_admin' } };
  try {
    await query(`CREATE TABLE app_schema_migrations(version text PRIMARY KEY);
      CREATE TABLE users(id int PRIMARY KEY,name text,email text,role text,organization_id int,is_active boolean DEFAULT true);
      INSERT INTO users VALUES(7,'Kuldeep Tomar','k@test','admin',1,true),(4,'Other admin','a@test','admin',1,true),
        (2,'Staff','s@test','sub_admin',1,true),(8,'Other organization','o@test','admin',2,true);
      CREATE TABLE sites(id int PRIMARY KEY,name text,organization_id int);
      INSERT INTO sites VALUES(10,'Site',1),(11,'Other site',1),(20,'Other organization',2);
      CREATE TABLE user_sites(user_id int,site_id int);INSERT INTO user_sites VALUES(2,10);
      CREATE TABLE members(id int PRIMARY KEY,full_name text);
      CREATE TABLE loyalty_vault_accounts(holder_key text PRIMARY KEY,organization_id int,holder_type text,holder_id int,
        balance numeric DEFAULT 0,reserved_balance numeric DEFAULT 0,updated_at timestamptz DEFAULT now());
      CREATE TABLE loyalty_vault_entries(id serial PRIMARY KEY,organization_id int,holder_key text,holder_type text,holder_id int,
        amount numeric,balance_after numeric,kind text,description text,source_table text,source_id int,cash_flow_entry_id int,
        site_id int,actor_id int,transfer_id uuid,details jsonb DEFAULT '{}',created_at timestamptz DEFAULT now());
      CREATE TABLE loyalty_vault_sources(cash_flow_entry_id int,posted_amount numeric);
      CREATE OR REPLACE FUNCTION loyalty_vault_guard_history() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'History is immutable'; END $$;
      CREATE TABLE imprest_allocations(id serial PRIMARY KEY,admin_id int,sub_admin_id int,site_id int,amount numeric,
        remark text,status text,assigned_admin_id int,proof_key text,from_own_float boolean DEFAULT false,
        site_balance_at_allocation numeric,override_reason text,confirmation_remark text,confirmed_at timestamptz,
        declined_at timestamptz,decline_reason text,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now());
      CREATE TABLE imprest_ledger(id serial PRIMARY KEY,user_id int,site_id int,type text,reference_id int,amount numeric,
        balance_after numeric,remarks text,created_by int,proof_key text,source_module text,created_at timestamptz DEFAULT now());
      CREATE TABLE imprest_debit_reservations(source_module text,reference_id int,user_id int,site_id int,amount numeric);
      CREATE TABLE imprest_site_debit_reservations(site_id int,amount numeric);
      CREATE TABLE imprest_transfers(id serial PRIMARY KEY,site_id int,from_user_id int,to_user_id int,amount numeric,remark text,initiated_by int);
      CREATE TABLE imprest_expense_requests(id serial PRIMARY KEY,site_id int,request_type text,status text,assigned_admin_id int,amount numeric);
      CREATE TABLE imprest_returns(id serial PRIMARY KEY,site_id int,sub_admin_id int,amount numeric,status text,reason text,
        payment_mode text,reviewed_by int,reviewed_at timestamptz,review_remark text,updated_at timestamptz);
      CREATE TABLE day_book(id serial PRIMARY KEY,site_id int,date date,particular text,entry_type text,debit numeric,credit numeric,
        remarks text,payment_mode text,category text,from_entity text,to_entity text,status text,created_by int,
        imprest_allocation_id int,is_imprest_internal boolean,approved_by int,approved_at timestamptz,updated_at timestamptz);
      -- Deliberately unrelated financial cash: it must never fund these issues.
      CREATE VIEW ledger_entries AS SELECT 10 AS site_id,CURRENT_DATE AS entry_date,'cash'::text AS bucket,
        999999::numeric AS credit,0::numeric AS debit;`);
    await query(walletBalanceGuardsSql);
    await installPermanentWalletGuards(db);
    await legacyGuards(db);
    await query("INSERT INTO imprest_allocations(admin_id,sub_admin_id,site_id,amount,status) VALUES(7,2,10,10,'RECEIVED')");
    await up(db); await up(db);
    t.mock.method(pool, 'connect', db.connect);
    t.mock.method(pool, 'query', query);
    await query("SELECT loyalty_vault_apply_delta('user:7',1,1000,'credit','Cash received',NULL,NULL,NULL,10)");
    await query("SELECT loyalty_vault_apply_delta('user:7',1,9000,'credit','Other site cash',NULL,NULL,NULL,11)");
    await query("SELECT loyalty_vault_apply_delta('user:4',1,5000,'credit','Other Admin cash',NULL,NULL,NULL,10)");

    await t.test('the site, portfolio and admin imprest use Kuldeep’s selected-site wallet', async () => {
      assert.equal(await cash(), 1000);
      assert.equal((await invoke(getBalance)).data.balance, 1000);
      const site = (await invoke(getSiteBalance)).data;
      assert.equal(site.cash_balance, 1000); assert.equal(site.available, 1000);
      const dashboard = await getCashWalletSiteBalanceDetail(10, '1900-01-01', '2999-01-01', db);
      assert.equal(dashboard.cashBalance, 1000); assert.equal(dashboard.distributableBalance, 1000);
      assert.equal(site.wallet_holder_id, 7); assert.equal(site.balance_source, 'CASH_WALLET');
      assert.equal((await getAccessibleSiteBalances(7, true, '2999-01-01', db)).find(s => s.site_id === 10).cash_balance, 1000);
      assert.equal(await scalar("SELECT count(*) FROM loyalty_vault_entries WHERE source_table='imprest_allocations'"), 0);
    });

    let allocation;
    await t.test('giving deducts immediately; acceptance credits float without charging the wallet again', async () => {
      const result = await issue(300); assert.equal(result.status, 201); allocation = result.data.allocation;
      assert.equal(allocation.wallet_funded, true); assert.equal(await cash(), 700); assert.equal(await staff(), 0);
      const accepted = await invoke(confirmReceipt, { confirmation_remark: 'Cash received' }, { params: { id: allocation.id }, ...receiver });
      assert.equal(accepted.status, 200); assert.equal(await cash(), 700); assert.equal(await staff(), 300);
      await query('UPDATE imprest_allocations SET status=status WHERE id=$1', [allocation.id]);
      assert.equal(await cash(), 700);
      const entry = (await query("SELECT * FROM loyalty_vault_entries WHERE source_table='imprest_allocations' AND source_id=$1", [allocation.id])).rows[0];
      assert.equal(entry.amount, '-300'); assert.equal(entry.details.counterparty_name, 'Staff');
    });
    await t.test('another site or holder cannot fund an excessive handover', async () => {
      const result = await issue(701); assert.equal(result.status, 400); assert.equal(await cash(), 700);
      await assert.rejects(query("INSERT INTO imprest_allocations(admin_id,sub_admin_id,site_id,amount,status) VALUES(7,2,10,701,'PENDING_RECEIPT')"),
        error => error.constraint === 'loyalty_vault_holder_funds');
      assert.equal(await cash(), 700);
    });
    await t.test('cancel and decline restore exact cash once, including a fully depleted wallet', async () => {
      const first = (await issue(700)).data.allocation; assert.equal(await cash(), 0);
      assert.equal((await invoke(cancelAllocation, {}, { params: { id: first.id } })).status, 200);
      assert.equal(await cash(), 700);
      await invoke(cancelAllocation, {}, { params: { id: first.id } }); assert.equal(await cash(), 700);
      const second = (await issue(700)).data.allocation;
      const result = await invoke(declineReceipt, { decline_reason: 'Did not receive' }, { params: { id: second.id }, ...receiver });
      assert.equal(result.status, 200); assert.equal(await cash(), 700);
    });
    await t.test('accepting an already funded full-wallet handover needs no spare site cash', async () => {
      const item = (await issue(700)).data.allocation; assert.equal(await cash(), 0);
      await invoke(confirmReceipt, { confirmation_remark: 'All received' }, { params: { id: item.id }, ...receiver });
      assert.equal(await cash(), 0); assert.equal(await staff(), 1000);
    });
    await t.test('staff returns restore cash and retrying cannot mint a second credit', async () => {
      await query("INSERT INTO imprest_returns(id,site_id,sub_admin_id,amount,status,payment_mode) VALUES(1,10,2,200,'PENDING','CASH')");
      assert.equal((await invoke(acceptReturn, {}, { params: { id: 1 } })).status, 200);
      assert.equal(await cash(), 200); assert.equal(await staff(), 800);
      await invoke(acceptReturn, {}, { params: { id: 1 } }); assert.equal(await cash(), 200);
    });
    await t.test('positive adjustments and direct Admin transfers consume the same wallet', async () => {
      assert.equal((await invoke(adjustBalance, { user_id: 2, amount: 50, site_id: 10 })).status, 200);
      assert.equal(await cash(), 150); assert.equal(await staff(), 850);
      assert.equal((await invoke(createTransfer, { to_user_id: 2, amount: 50, site_id: 10 })).status, 201);
      assert.equal(await cash(), 100); assert.equal(await staff(), 900);
    });
    await t.test('wallet postings roll back with a failed handover transaction and migration reruns preserve history', async subtest => {
      const before = await cash();
      subtest.mock.method(dayBookModel, 'create', async () => { throw new Error('Day Book write failed'); });
      await assert.rejects(issue(50), /Day Book write failed/);
      assert.equal(await cash(), before);
      await query('BEGIN');
      await postImprestWalletMovement(db, { table: 'imprest_transfers', id: 999, userId: 7, siteId: 10,
        amount: -10, actorId: 7, description: 'Rollback test' });
      await query('ROLLBACK'); assert.equal(await cash(), before);
      await up(db); await up(db); assert.equal(await cash(), before);
    });
  } finally { await pg.close(); }
});
