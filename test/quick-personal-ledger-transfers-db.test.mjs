import test from 'node:test';
import assert from 'node:assert/strict';
import {installFunding} from './fixtures/personal-ledger-funding.mjs';
import {randomUUID} from 'node:crypto';
import {pgliteFixture,fixtureLedger,fixtureEntry,ledgerFunds,organizationFunds,siteFunds} from './fixtures/cashflow-money-transfers.mjs';
import {up} from '../src/migrations/240_quick_personal_ledger_transfers.js';
import {up as reinstallReceiptTransfers} from '../src/migrations/237_cashflow_money_transfers.js';
import {createQuickPersonalLedgerTransfer as create,quickTransferContext} from '../src/services/quickPersonalLedgerTransfer.service.js';
import {transferEligibility,moneyMinor} from '../src/services/cashflowTransfer.service.js';
import {up as installSiteCashReceipts} from '../src/migrations/255_site_cash_receipts.js';
import {siteCashReceiptContext,unreadSiteDebits,readSiteDebit} from '../src/services/siteCashReceipt.service.js';

test('a linked cash receipt posts a matching debit and a durable notice only in the sending site', async () => {
  const { db, close } = await pgliteFixture();
  try {
    await installFunding(db);
    await installSiteCashReceipts(db);
    await installSiteCashReceipts(db);
    const source = await fixtureLedger(db, { name: 'Sending ledger', month: 1, year: 2025 });
    const destination = await fixtureLedger(db, { site: 11, name: 'Sending site', month: 1, year: 2025 });
    const priorCredit = await fixtureEntry(db, destination, { status: 'pending' });
    await fixtureEntry(db, source, { credit: '1500000.00' });
    await db.query("SELECT loyalty_vault_apply_delta('user:1',1,1500000,'credit','Opening cash',NULL,NULL,NULL,10,1)");
    await db.query('UPDATE cash_flow_months SET cash_receipt_source_site_id=10 WHERE id=$1', [destination.id]);
    await db.query("UPDATE cash_flow_entries SET status='approved' WHERE id=$1", [priorCredit.id]);

    await assert.rejects(fixtureEntry(db, destination, { credit: '1000000.00' }),
      error => error.constraint === 'site_cash_receipt_requires_transfer');
    const nextPeriod = await fixtureLedger(db, { site: 11, name: 'Sending site', month: 2, year: 2025 });
    assert.equal(nextPeriod.cash_receipt_source_site_id, 10);
    const context = await siteCashReceiptContext({ id: 1 }, nextPeriod.id, db);
    assert.equal(context.source_site.id, 10);
    assert.deepEqual(context.source_ledgers.map(row => row.id), [source.id]);
    await assert.rejects(siteCashReceiptContext({ id: 3 }, nextPeriod.id, db), errorCode('LEDGER_NOT_FOUND'));

    const request = { source_ledger_id: source.id, destination_ledger_id: nextPeriod.id, amount: '1000000.00',
      idempotency_key: randomUUID(), authorize_above_limit: true };
    const wrongSource = await fixtureLedger(db, { site: 11, month: 1, year: 2025 });
    await assert.rejects(create({ id: 1 }, { ...request, source_ledger_id: wrongSource.id }, db, { siteReceipt: true }),
      errorCode('RECEIPT_SOURCE_CHANGED'));
    assert.equal((await unreadSiteDebits({ id: 1 }, 10, db)).unread_count, 0);
    const before = await organizationFunds(db);
    const { transfer } = await create({ id: 1 }, request, db, { siteReceipt: true });
    assert.deepEqual(transfer.entries.map(entry => [entry.site_id, entry.debit, entry.credit]), [
      [11, '0.00', '1000000.00'], [10, '1000000.00', '0.00'],
    ]);
    assert.equal(await siteFunds(db, 10), '500000.00');
    assert.equal(await siteFunds(db, 11), '1000100.00');
    assert.equal(await organizationFunds(db), before);
    assert.equal((await create({ id: 1 }, request, db, { siteReceipt: true })).replayed, true);
    const inbox = await unreadSiteDebits({ id: 1 }, 10, db);
    assert.equal(inbox.unread_count, 1);
    assert.equal(inbox.notices[0].transfer_id, transfer.id);
    assert.equal(inbox.notices[0].amount, '1000000.00');
    assert.equal((await unreadSiteDebits({ id: 1 }, 11, db)).unread_count, 0);
    assert.equal((await unreadSiteDebits({ id: 4 }, 10, db)).unread_count, 0);
    assert.equal((await unreadSiteDebits({ id: 7 }, 10, db)).unread_count, 0);
    assert.equal((await unreadSiteDebits({ id: 3 }, 10, db)).unread_count, 1);
    await readSiteDebit({ id: 1 }, 11, transfer.id, db);
    assert.equal((await unreadSiteDebits({ id: 1 }, 10, db)).unread_count, 1);
    await readSiteDebit({ id: 1 }, 10, transfer.id, db);
    assert.equal((await unreadSiteDebits({ id: 1 }, 10, db)).unread_count, 0);
    assert.equal((await unreadSiteDebits({ id: 3 }, 10, db)).unread_count, 1);

    await db.query("SELECT loyalty_vault_apply_delta('user:1',1,100,'credit','Cash at the sending site',NULL,NULL,NULL,11,1)");
    const { transfer: reverse } = await create({ id: 1 }, {
      source_ledger_id: nextPeriod.id,
      destination_ledger_id: source.id,
      amount: '80.00',
      idempotency_key: randomUUID(),
      authorize_above_limit: true,
    }, db);
    assert.equal(await siteFunds(db, 11), '1000020.00');
    assert.equal(await siteFunds(db, 10), '500080.00');
    assert.equal(await organizationFunds(db), before);
    assert.equal((await unreadSiteDebits({ id: 1 }, 11, db)).notices[0].transfer_id, reverse.id);
    assert.equal((await unreadSiteDebits({ id: 1 }, 10, db)).unread_count, 0);
  } finally {
    await close();
  }
});

const errorCode=code=>error=>error.code===code;
async function wallet(db,user=1,site=10){return (await db.query('SELECT COALESCE(sum(amount),0)::numeric(15,2)::text AS balance FROM loyalty_vault_entries WHERE holder_key=$1 AND site_id=$2',[`user:${user}`,site])).rows[0].balance;}
async function float(db,user=2,site=10){return (await db.query('SELECT COALESCE(sum(amount),0)::numeric(15,2)::text AS balance FROM imprest_ledger WHERE user_id=$1 AND site_id=$2',[user,site])).rows[0].balance;}

test('quick personal ledger transfers debit only the actor funding account and commit both accounting sides',async t=>{
 const {db,close}=await pgliteFixture();
 try {
  await installFunding(db);
  const reserves=await fixtureLedger(db,{name:'Site cash reserve'});await fixtureEntry(db,reserves,{credit:'5000.00'});
  await db.query("SELECT loyalty_vault_apply_delta('user:1',1,1000,'credit','Own cash',NULL,NULL,NULL,10,1)");
  await db.query("SELECT loyalty_vault_apply_delta('user:3',1,2000,'credit','Other owner cash',NULL,NULL,NULL,10,3)");
  await db.query("INSERT INTO imprest_ledger(user_id,type,amount,balance_after,remarks,created_by,site_id) VALUES(2,'ALLOCATION',500,500,'Own float',1,10),(3,'ALLOCATION',1000,1000,'Other float',1,10)");
  await db.query(`CREATE FUNCTION reconcile_test_quick_sources() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
   PERFORM reconcile_direct_cashflow_imprest(NEW.id);PERFORM reconcile_loyalty_vault_entry(NEW.id);RETURN NEW;END $$;
   CREATE CONSTRAINT TRIGGER test_native_quick_source_sync AFTER INSERT ON cash_flow_entries DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reconcile_test_quick_sources();
   INSERT INTO application_settings(site_id,setting_key,setting_value) VALUES(NULL,'cashflow_transfer_approval_limit:organization:1','{"approval_limit":"50000.00"}');`);
  const source=await fixtureLedger(db,{name:'Personal source'}),same=await fixtureLedger(db,{name:'Same site destination'}),cross=await fixtureLedger(db,{site:11,name:'Cross site destination'});
  const request=(destination=cross,amount='100.15',extra={})=>({source_ledger_id:source.id,destination_ledger_id:destination.id,amount,idempotency_key:randomUUID(),...extra});
  await t.test('context uses the logged-in role and exposes only its own site funding',async()=>{
   const admin=await quickTransferContext({id:1,role:'sub_admin'},{source_ledger_id:source.id},db);
   assert.equal(admin.funding.type,'wallet');assert.equal(admin.funding.user_id,1);assert.equal(admin.funding.available_balance,'1000.00');assert.equal(admin.can_transfer,true);
   assert.equal(admin.date_editable,true);assert.match(admin.today,/^\d{4}-\d{2}-\d{2}$/);
   const staff=await quickTransferContext({id:2,role:'admin'},{source_ledger_id:source.id},db);
   assert.equal(staff.funding.type,'imprest');assert.equal(staff.funding.available_balance,'500.00');
   await db.query("INSERT INTO imprest_debit_reservations(source_module,reference_id,user_id,site_id,amount) VALUES('expense',999,2,10,40)");
   assert.equal((await quickTransferContext({id:2},{source_ledger_id:source.id},db)).funding.available_balance,'460.00');
  });
  await t.test('admin same/cross site: own wallet decreases once and personal source may be negative',async()=>{
   for(const destination of [same,cross]) {
    const beforeOrg=await organizationFunds(db),beforeSite=moneyMinor(await siteFunds(db,10)),beforeWallet=moneyMinor(await wallet(db)),data=request(destination);
    const result=await create({id:1},data,db),row=result.transfer;
    assert.equal(row.amount,'100.15');assert.equal(row.funding_type,'wallet');assert.match(row.reference,/^QFT-/);
    assert.equal(row.entries.length,2);assert.equal(row.transfer_type,destination===same?'same_site':'cross_site');
    assert.equal(moneyMinor(await wallet(db)),beforeWallet-10015n);assert.equal(await wallet(db,3),'2000.00');
    assert.equal(await organizationFunds(db),beforeOrg);assert.equal(moneyMinor(await siteFunds(db,10)),beforeSite-(destination===same?0n:10015n));
    assert.equal((await create({id:1},data,db)).replayed,true);assert.equal(moneyMinor(await wallet(db)),beforeWallet-10015n);
    await assert.rejects(create({id:1},{...data,amount:'100.16'},db),errorCode('IDEMPOTENCY_CONFLICT'));
   }
   assert.equal(await ledgerFunds(db,source.id),'-200.30');assert.equal(await ledgerFunds(db,same.id),'100.15');assert.equal(await ledgerFunds(db,cross.id),'100.15');
  });
  await t.test('sub-admin consumes only own imprest, never any wallet, and reservations remain unavailable',async()=>{
   const beforeWallet=await wallet(db),beforeOther=await float(db,3),data=request(cross,'400.00');
   const result=await create({id:2},data,db);
   assert.equal(result.transfer.funding_type,'imprest');assert.equal(await float(db),'100.00');assert.equal(await float(db,3),beforeOther);assert.equal(await wallet(db),beforeWallet);
   assert.equal((await quickTransferContext({id:2},{source_ledger_id:source.id},db)).funding.available_balance,'60.00');
   assert.equal((await create({id:2},data,db)).replayed,true);assert.equal(await float(db),'100.00');
   await assert.rejects(create({id:2},request(cross,'60.01'),db),errorCode('INSUFFICIENT_IMPREST'));
   assert.equal(await wallet(db,2),'0.00');assert.equal(await wallet(db,2,11),'0.00');
  });
  await t.test('wallet/site access and current financial state fail closed',async()=>{
   await assert.rejects(create({id:1},request(cross,'1000.00'),db),errorCode('INSUFFICIENT_WALLET_BALANCE'));
   await assert.rejects(create({id:3},request(cross,'1'),db),errorCode('LEDGER_NOT_FOUND'));
   await assert.rejects(create({id:4},request(cross,'1'),db),errorCode('LEDGER_NOT_FOUND'));
   await assert.rejects(create({id:6},request(same,'1'),db),errorCode('TRANSFER_FORBIDDEN'));
   await assert.rejects(create({id:7},request(same,'1'),db),errorCode('TRANSFER_FORBIDDEN'));
   for(const amount of ['0','-1','0.001','NaN','1e3'])await assert.rejects(create({id:1},request(same,amount),db),errorCode('INVALID_AMOUNT'));
   await assert.rejects(create({id:1},request(source,'1'),db),errorCode('SAME_LEDGER'));
   await assert.rejects(create({id:1},request(same,'1',{date:'2099-01-01'}),db),errorCode('INVALID_DATE'));
   await assert.rejects(create({id:1},request(same,'1',{cash_type:'bank'}),db),errorCode('INVALID_PAYMENT_MODE'));
   await db.query('UPDATE cash_flow_months SET is_locked=true WHERE id=$1',[same.id]);
   await assert.rejects(create({id:1},request(same,'1'),db),errorCode('LEDGER_UNAVAILABLE'));
   await db.query('UPDATE cash_flow_months SET is_locked=false WHERE id=$1',[same.id]);
  });
  await t.test('funding failure rolls back header, both ledger rows, and wallet balance',async()=>{
   const before=await wallet(db),entries=(await db.query('SELECT count(*)::int AS n FROM cash_flow_entries')).rows[0].n,count=(await db.query('SELECT count(*)::int AS n FROM cashflow_quick_transfers')).rows[0].n;
   await db.query("CREATE FUNCTION fail_quick_wallet() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.source_table='cashflow_quick_transfers' THEN RAISE EXCEPTION 'Simulated wallet failure'; END IF;RETURN NEW;END $$;CREATE TRIGGER fail_quick_wallet BEFORE INSERT ON loyalty_vault_entries FOR EACH ROW EXECUTE FUNCTION fail_quick_wallet()");
   const data=request(same,'1');await assert.rejects(create({id:1},data,db),/Simulated wallet failure/);
   assert.equal(await wallet(db),before);assert.equal((await db.query('SELECT count(*)::int AS n FROM cash_flow_entries')).rows[0].n,entries);assert.equal((await db.query('SELECT count(*)::int AS n FROM cashflow_quick_transfers')).rows[0].n,count);
   await db.query('DROP TRIGGER fail_quick_wallet ON loyalty_vault_entries');
   assert.equal((await create({id:1},data,db)).replayed,false);
  });
  await t.test('approval limits require an admin confirmation and never override own funding',async()=>{
   await db.query(`UPDATE application_settings SET setting_value='{"approval_limit":"1.00"}' WHERE setting_key='cashflow_transfer_approval_limit:organization:1'`);
   const context=await quickTransferContext({id:1},{source_ledger_id:source.id},db);assert.equal(context.approval_limit,'1.00');assert.equal(context.can_authorize,true);
   await assert.rejects(create({id:2},request(cross,'2.00',{authorize_above_limit:true}),db),errorCode('ADMIN_AUTHORIZATION_REQUIRED'));
   await assert.rejects(create({id:1},request(cross,'2.00'),db),errorCode('ADMIN_AUTHORIZATION_REQUIRED'));
   await assert.rejects(create({id:1},request(cross,'2.00',{authorize_above_limit:'true'}),db),errorCode('INVALID_AUTHORIZATION'));
   const result=await create({id:1},request(cross,'2.00',{authorize_above_limit:true}),db);assert.equal(result.transfer.authorized_by,1);assert.ok(result.transfer.authorized_at);
   await assert.rejects(create({id:1},request(cross,'999.00',{authorize_above_limit:true}),db),errorCode('INSUFFICIENT_WALLET_BALANCE'));
  });
  await t.test('rerunning receipt-transfer migration preserves quick links and new transfers remain valid',async()=>{
   await reinstallReceiptTransfers(db);await up(db);
   assert.equal((await create({id:1},request(same,'1.00'),db)).transfer.amount,'1.00');
  });
  await t.test('transaction date honors the source site date-edit policy and transaction time',async()=>{
   const dates=(await db.query("SELECT (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::date::text AS today,((CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::date-1)::text AS yesterday")).rows[0];
   await db.query("INSERT INTO application_settings(site_id,setting_key,setting_value) VALUES(10,'transaction_date_editable','false')");
   const context=await quickTransferContext({id:2},{source_ledger_id:source.id},db);assert.equal(context.date_editable,false);assert.equal(context.today,dates.today);
   const forced=await create({id:1},request(same,'0.10',{date:dates.yesterday,transaction_time:'10:15'}),db);
   assert.equal(new Date(forced.transfer.entry_date).toISOString().slice(0,10),dates.today);
   await db.query("DELETE FROM application_settings WHERE site_id=10 AND setting_key='transaction_date_editable'");
   const historical=await create({id:1},request(same,'0.10',{date:dates.yesterday,transaction_time:'10:16'}),db);
   assert.equal(new Date(historical.transfer.entry_date).toISOString().slice(0,10),dates.yesterday);
   const times=(await db.query('SELECT transaction_time::text AS time FROM cash_flow_entries WHERE quick_transfer_id=$1',[historical.transfer.id])).rows;
   assert.ok(times.every(row=>row.time==='10:16:00'));
  });
  await t.test('complete transfers are immutable, ledger identity is protected, and quick receipts are not reallocatable',async()=>{
   const row=(await db.query('SELECT id FROM cashflow_quick_transfers LIMIT 1')).rows[0],entry=(await db.query('SELECT id FROM cash_flow_entries WHERE quick_transfer_id=$1 LIMIT 1',[row.id])).rows[0];
   for(const sql of ['UPDATE cashflow_quick_transfers SET amount=amount+1 WHERE id=$1','DELETE FROM cashflow_quick_transfers WHERE id=$1'])await assert.rejects(db.query(sql,[row.id]),/immutable/);
   await assert.rejects(db.query('DELETE FROM cash_flow_entries WHERE id=$1',[entry.id]),/immutable/);
   await assert.rejects(db.query('UPDATE cash_flow_entries SET debit=debit+1 WHERE id=$1',[entry.id]),/immutable/);
   await assert.rejects(db.query('UPDATE cash_flow_months SET opening_balance=100 WHERE id=$1',[source.id]),/transferred ledger/);
   const floatEntry=(await db.query("SELECT id FROM imprest_ledger WHERE source_module='quick_personal_transfer' LIMIT 1")).rows[0];
   await assert.rejects(db.query('DELETE FROM imprest_ledger WHERE id=$1',[floatEntry.id]),/immutable/);
   await assert.rejects(db.query('UPDATE imprest_ledger SET amount=0 WHERE id=$1',[floatEntry.id]),/immutable/);
   const eligibility=await transferEligibility({id:1},{source_ledger_id:cross.id},db);assert.ok(eligibility.entries.every(e=>e.eligible===false));
   const receipt=(await db.query("SELECT id FROM cash_flow_entries WHERE quick_transfer_leg='credit' LIMIT 1")).rows[0];
   await assert.rejects(db.query("INSERT INTO transaction_money_transfers(id,source_type,source_record_id) VALUES($1,'personal_ledger',$2)",[randomUUID(),receipt.id]),/already allocated/);
  });
 } finally {await close();}
});
