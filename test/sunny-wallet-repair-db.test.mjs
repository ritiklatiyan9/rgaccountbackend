import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { up as walletUp } from '../src/migrations/185_cash_wallets.js';
import { up as vaultUp } from '../src/migrations/199_loyalty_vault.js';
import { up as unifiedUp,cashWalletReconciliationSql } from '../src/migrations/203_unified_cash_wallet.js';
import { up as siteUp } from '../src/migrations/208_cash_wallet_site_scope.js';
import { up as detailsUp } from '../src/migrations/209_cash_wallet_receipt_details.js';
import { up as balanceUp } from '../src/migrations/210_wallet_balance_guards.js';
import { up as collectorUp } from '../src/migrations/211_locked_cash_collector.js';
import { up as permanentUp } from '../src/migrations/212_wallet_permanent_balance_guard.js';
import { repairSunnyWallet,SUNNY_WALLET_REPAIR as target } from '../src/services/sunnyWalletRepair.service.js';
import { LOYALTY_VAULT_SOURCE_TABLES } from '../src/services/loyaltyVaultContext.service.js';
import { postingPolicySql } from '../src/migrations/171_cheque_clearance_before_approval.js';
import { createVaultTransfer,resolveVaultTransfer } from '../src/services/loyaltyVault.service.js';

test('Sunny exact debit repair is recoverable, repeatable and protected against recurrence', {skip:!process.env.PGLITE_MODULE}, async t=>{
  const {PGlite}=await import(process.env.PGLITE_MODULE),pg=new PGlite();
  const query=async(sql,args)=>{
    const r=args?.length?await pg.query(sql,args):(await pg.exec(sql)).at(-1);
    return {...r,rows:r?.rows||[],rowCount:r?.affectedRows??r?.rows?.length??0};
  };
  const db={query,connect:async()=>({query,release(){}})};
  const scalar=async(sql,args)=>(await query(sql,args)).rows[0];
  const live=async()=>JSON.stringify({entries:(await query('SELECT * FROM loyalty_vault_entries ORDER BY id')).rows,
    accounts:(await query('SELECT * FROM loyalty_vault_accounts ORDER BY holder_key')).rows,
    source:(await query('SELECT * FROM loyalty_vault_sources ORDER BY cash_flow_entry_id')).rows,
    cash:(await query('SELECT * FROM cash_flow_entries ORDER BY id')).rows,
    payments:(await query('SELECT * FROM plot_payments ORDER BY id')).rows,
    transfers:(await query('SELECT * FROM loyalty_vault_transfers ORDER BY id')).rows});
  const balance=async()=>(await scalar("SELECT balance::text FROM loyalty_vault_accounts WHERE holder_key='user:2'")).balance;
  const noFunds=e=>e.constraint==='loyalty_vault_holder_funds';
  try {
    await query(`CREATE TABLE app_schema_migrations(version text PRIMARY KEY);
      CREATE TABLE users(id int PRIMARY KEY,name text,role text,organization_id int,is_active boolean DEFAULT true);
      INSERT INTO users VALUES(2,'Sunny Latiyan','sub_admin',1,true),(7,'Kuldeep Tomar','admin',1,true);
      CREATE TABLE sites(id int PRIMARY KEY,name text,organization_id int);INSERT INTO sites VALUES(2,'Mount Valley Residency',1),(9,'Green Valley Test',1);
      CREATE TABLE user_sites(user_id int,site_id int);INSERT INTO user_sites VALUES(2,2);
      CREATE TABLE members(id int PRIMARY KEY,site_id int,full_name text,phone text);
      CREATE TABLE user_permissions(user_id int,module text,can_read boolean,can_view_all boolean);
      CREATE TABLE cash_flow_months(id int PRIMARY KEY,site_id int);CREATE TABLE farmers(id int PRIMARY KEY,site_id int);
      CREATE TABLE firms(id int PRIMARY KEY,site_id int);CREATE TABLE plots(id int PRIMARY KEY,site_id int);
      CREATE TABLE plot_installments(id int PRIMARY KEY,plot_id int);
      CREATE TABLE cash_flow_entries(id int PRIMARY KEY,site_id int,created_by int,credit numeric DEFAULT 0,debit numeric DEFAULT 0,
        cash_type text,status text,cheque_status text,particular text,source_module text,source_id int,date date DEFAULT CURRENT_DATE,
        created_at timestamptz DEFAULT now(),entry_transfer_id uuid,is_imprest_internal boolean,is_firm_transaction boolean,to_firm_id int);
      ${postingPolicySql}`);
    for(const table of [...LOYALTY_VAULT_SOURCE_TABLES].filter(table=>table!=='cash_flow_entries'))await query(`CREATE TABLE ${table}(
      id int PRIMARY KEY,site_id int,created_by int,status text,payment_mode text,payment_type text,cheque_status text,
      created_at timestamptz DEFAULT now(),amount numeric,cash_amount numeric,remarks text,description text,narration text,particular text,
      farmer_id int,firm_id int,plot_id int,installment_id int,entry_type text,cash_flow_entry_id int,
      expense_id int,farmer_payment_id int,commission_id int,firm_transaction_id int,plot_payment_id int,vendor_payment_id int,imprest_allocation_id int,
      source_vendor_payment_id int,entry_transfer_id uuid,money_transfer_id uuid,is_firm_to_firm_transfer boolean,
      transfer_group_id uuid,is_financial_projection boolean,is_imprest_internal boolean)`);
    await walletUp(db);await vaultUp(db);await unifiedUp(db);await siteUp(db);
    await query("SELECT setval(pg_get_serial_sequence('loyalty_vault_entries','id'),121,true)");
    await query("INSERT INTO plot_payments(id,site_id,created_by,status,payment_mode,amount) VALUES(7646,2,2,'pending','CASH',100000)");
    await query("INSERT INTO cash_flow_entries(id,site_id,created_by,status,cash_type,credit,particular,source_module,source_id) VALUES(74989,2,2,'pending','cash',100000,'PLOT PAYMENT - CASH','plot_payments',7646)");
    await query(`INSERT INTO loyalty_vault_transfers(id,organization_id,site_id,from_holder_type,from_holder_id,to_holder_id,sender_id,recipient_id,amount,status,idempotency_key)
      VALUES($1,1,2,'user',2,7,2,7,100000,'accepted',$2)`,[target.transferId,randomUUID()]);
    await query("SELECT loyalty_vault_apply_delta('user:2',1,-100000,'transfer_out','Cash handover accepted',NULL,NULL,NULL,2,7,$1)",[target.transferId]);
    await query("SELECT loyalty_vault_apply_delta('user:7',1,100000,'transfer_in','Cash handover received',NULL,NULL,NULL,2,7,$1)",[target.transferId]);
    await query("SELECT setval(pg_get_serial_sequence('loyalty_vault_entries','id'),140,true)");
    await query("UPDATE plot_payments SET status='rejected' WHERE id=7646");
    await query("UPDATE cash_flow_entries SET status='rejected' WHERE id=74989");
    await detailsUp(db);await balanceUp(db);await collectorUp(db);
    assert.equal(await balance(),'-100000.00');
    let snapshot;

    await t.test('preview rolls back every financial and schema change and requires a durable snapshot for apply',async()=>{
      const before=await live();
      const report=await repairSunnyWallet(db,{writeSnapshot:async value=>{snapshot=value;}});
      assert.equal(report.applied,false);assert.equal(report.balance,'0.00');assert.equal(await live(),before);
      assert.equal(snapshot.before.entries.find(e=>String(e.id)==='141').kind,'reversal');
      assert.equal((await scalar("SELECT to_regclass('cash_wallet_voided_receipt_entries') AS table_name")).table_name,null);
      await assert.rejects(repairSunnyWallet(db,{apply:true}),/snapshot writer/);
      await assert.rejects(repairSunnyWallet(db,{apply:true,writeSnapshot:async()=>{throw new Error('Snapshot unavailable');}}),/Snapshot unavailable/);
      assert.equal(await live(),before);
    });

    await t.test('identity/amount conflicts cannot delete another entry',async()=>{
      await query("UPDATE users SET name='Different Sunny' WHERE id=2");
      await assert.rejects(repairSunnyWallet(db),/Sunny account differs/);
      assert.ok((await query('SELECT id FROM loyalty_vault_entries WHERE id=141')).rows.length);
      await query("UPDATE users SET name='Sunny Latiyan' WHERE id=2");
    });

    await t.test('apply removes only 141, archives the complete debit and leaves receipt, handover and other holders intact',async()=>{
      const result=await repairSunnyWallet(db,{apply:true,writeSnapshot:async value=>{snapshot=value;}});
      assert.equal(result.applied,true);assert.equal(result.negative_debits_blocked,true);assert.equal(await balance(),'0.00');
      assert.equal((await query('SELECT id FROM loyalty_vault_entries WHERE id=141')).rows.length,0);
      const archive=await scalar('SELECT * FROM cash_wallet_voided_receipt_entries WHERE original_entry_id=141');
      assert.equal(Number(archive.original_entry.amount),-100000);assert.equal(Number(archive.retained_amount),100000);
      assert.equal((await scalar('SELECT status FROM plot_payments WHERE id=7646')).status,'rejected');
      assert.equal((await scalar('SELECT status FROM loyalty_vault_transfers WHERE id=$1',[target.transferId])).status,'accepted');
      assert.equal((await scalar('SELECT posted_amount::text FROM loyalty_vault_sources WHERE cash_flow_entry_id=74989')).posted_amount,'0.00');
      const before=await live();
      const replay=await repairSunnyWallet(db,{apply:true,writeSnapshot:async()=>{throw new Error('Replay must not need another snapshot');}});
      assert.equal(replay.replayed,true);assert.equal(await live(),before);
      await assert.rejects(query("UPDATE cash_wallet_voided_receipt_entries SET reason='tampered'"),/immutable/);
      await assert.rejects(query('DELETE FROM loyalty_vault_entries WHERE id=122'),/immutable/);
    });

    await t.test('rejection recalculation and re-approval neither recreate the debit nor credit the same cash twice',async()=>{
      await query('SELECT reconcile_loyalty_vault_entry(74989)');await query('SELECT reconcile_loyalty_vault_entry(74989)');
      assert.equal(await balance(),'0.00');
      const count=(await scalar('SELECT count(*)::int AS n FROM loyalty_vault_entries')).n;
      await query('BEGIN');
      try {
      await query('SET CONSTRAINTS ALL IMMEDIATE');
      await query("UPDATE plot_payments SET status='approved' WHERE id=7646");
      await query("UPDATE cash_flow_entries SET status='approved' WHERE id=74989");
      assert.equal(await balance(),'0.00');assert.equal((await scalar('SELECT count(*)::int AS n FROM loyalty_vault_entries')).n,count);
      await query('SAVEPOINT reject_reapproved_receipt');
      await assert.rejects(query("UPDATE plot_payments SET status='rejected' WHERE id=7646"),noFunds);
      await query('ROLLBACK TO SAVEPOINT reject_reapproved_receipt');
      assert.equal((await scalar('SELECT status FROM plot_payments WHERE id=7646')).status,'approved');
      } finally {await query('ROLLBACK');}
      assert.equal(await balance(),'0.00');
    });

    await t.test('new receipts cannot be rejected, reduced or deleted after their full handover',async()=>{
      await query("INSERT INTO cash_flow_entries(id,site_id,created_by,status,cash_type,credit,particular) VALUES(75000,2,2,'approved','CASH',250,'New cash receipt')");
      const transfer=await createVaultTransfer({id:2},{site_id:2,to_holder_id:7,amount:'250',idempotency_key:randomUUID()},db);
      await resolveVaultTransfer({id:7},transfer.transfer.id,'accept',{site_id:2},db);
      assert.equal(await balance(),'0.00');
      const before=await live();
      await assert.rejects(query("UPDATE cash_flow_entries SET status='rejected' WHERE id=75000"),noFunds);
      await assert.rejects(query('UPDATE cash_flow_entries SET credit=100 WHERE id=75000'),noFunds);
      await assert.rejects(query('DELETE FROM cash_flow_entries WHERE id=75000'),noFunds);
      assert.equal(await live(),before);
    });

    await t.test('older repeatable SQL cannot bypass the permanent guard or recreate the voided debit',async()=>{
      const count=(await scalar('SELECT count(*)::int AS n FROM loyalty_vault_entries')).n;
      await vaultUp(db);
      await assert.rejects(query("SELECT loyalty_vault_apply_delta('user:2',1,-0.01,'adjustment','Old code',NULL,NULL,NULL,2)"),noFunds);
      await unifiedUp(db);
      // Migration 207 installs the same shared reconciliation definition.
      await query(cashWalletReconciliationSql);await query('SELECT reconcile_loyalty_vault_entry(74989)');
      await siteUp(db);await detailsUp(db);await balanceUp(db);await collectorUp(db);await permanentUp(db);await permanentUp(db);
      assert.equal(await balance(),'0.00');assert.equal((await scalar('SELECT count(*)::int AS n FROM loyalty_vault_entries')).n,count);
      await assert.rejects(query("INSERT INTO loyalty_vault_entries(organization_id,holder_key,holder_type,holder_id,site_id,amount,balance_after,kind) VALUES(1,'user:2','user',2,2,-1,-1,'adjustment')"),noFunds);
    });
  } finally {await pg.close();}
});
