import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { up,down } from '../src/migrations/237_cashflow_money_transfers.js';
import { createCashflowTransfer as create, transferEligibility,transferDestinations,listCashflowTransfers,getCashflowTransfer,
  getTransferSettings,updateTransferSettings,moneyMinor,moneyDecimal } from '../src/services/cashflowTransfer.service.js';
import {cacheGet,cacheSet,getCacheGeneration} from '../src/config/cache.js';
import {pgliteFixture,fixturePair,fixtureEntry,fixtureLedger,ledgerFunds,organizationFunds,siteFunds} from './fixtures/cashflow-money-transfers.mjs';

const admin={id:1},staff={id:2},errorCode=code=>error=>error.code===code;
test('exact transfer amounts reject invalid values without binary arithmetic',()=>{
  assert.equal(moneyMinor('9999999999999.99'),999999999999999n);
  assert.equal(moneyDecimal(moneyMinor('0.10')+moneyMinor('0.20')),'0.30');
  for(const invalid of ['1e4','NaN','Infinity','0.001','10000000000000.00','',null]) assert.throws(()=>moneyMinor(invalid),errorCode('INVALID_AMOUNT'));
});

test('Cashflow transfers preserve money and enforce database integrity in isolated PostgreSQL',async t=>{
  const {db,close}=await pgliteFixture();
  try {
    await up(db);
    await t.test('unused installation is reversible and migration can be applied twice',async()=>{
      await down(db);await up(db);await up(db);
      assert.equal((await db.query('SELECT count(*)::int AS n FROM cash_flow_entries')).rows[0].n,0);
    });
    await t.test('default approval limit fails closed and only active admins configure it',async()=>{
      assert.equal((await getTransferSettings(admin,{},db)).approval_limit,'0.00');
      const {request}=await fixturePair(db);
      await assert.rejects(create(admin,request,db),errorCode('ADMIN_AUTHORIZATION_REQUIRED'));
      await assert.rejects(updateTransferSettings(staff,{approval_limit:'50000'},db),errorCode('TRANSFER_FORBIDDEN'));
      await assert.rejects(updateTransferSettings({id:5},{approval_limit:'50000'},db),errorCode('TRANSFER_FORBIDDEN'));
      assert.equal((await updateTransferSettings(admin,{approval_limit:'50000'},db)).approval_limit,'50000.00');
    });
    for(const site of [10,11]) for(const credits of [['100.01'],['100.01','200.02']]) {
      await t.test(`${site===10?'same':'cross'} site, ${credits.length} receipts: linked pairs conserve organization funds`,async()=>{
        const {source,destination,entries,request}=await fixturePair(db,{site,credits});
        const before=await organizationFunds(db),sourceSite=moneyMinor(await siteFunds(db,10)),destSite=moneyMinor(await siteFunds(db,site));
        const amount=moneyDecimal(credits.reduce((n,v)=>n+moneyMinor(v),0n));
        const result=await create(staff,request,db),row=result.transfer;
        assert.equal(result.replayed,false);assert.equal(row.amount,amount);assert.equal(row.status,'completed');
        assert.equal(row.transfer_type,site===10?'same_site':'cross_site');assert.match(row.reference,/^CFT-/);
        assert.equal(await ledgerFunds(db,source.id),'0.00');assert.equal(await ledgerFunds(db,destination.id),amount);
        assert.equal(await organizationFunds(db),before);
        assert.equal(moneyMinor(await siteFunds(db,10)),site===10?sourceSite:sourceSite-moneyMinor(amount));
        assert.equal(moneyMinor(await siteFunds(db,site)),site===10?destSite:destSite+moneyMinor(amount));
        assert.equal(row.entries.length,2);assert.equal(row.allocations.length,credits.length);
        assert.equal(row.entries.reduce((n,e)=>n+moneyMinor(e.debit)-moneyMinor(e.credit),0n),0n);
        assert.deepEqual((await db.query('SELECT credit::text FROM cash_flow_entries WHERE id=ANY($1) ORDER BY id',[entries.map(e=>e.id)])).rows.map(e=>e.credit),credits);
        assert.equal((await db.query('SELECT count(*)::int AS n FROM cashflow_transfer_audit WHERE transfer_id=$1',[row.id])).rows[0].n,1);
      });
    }
    await t.test('below, exactly equal, and above approval threshold are checked against current database role',async()=>{
      await updateTransferSettings(admin,{approval_limit:'50.00'},db);
      for(const amount of ['49.99','50.00']) {
        const {request}=await fixturePair(db,{credits:[amount]});
        assert.equal((await create(staff,request,db)).transfer.authorized_by,null);
      }
      const {request}=await fixturePair(db,{credits:['50.01']});
      await assert.rejects(create(staff,{...request,authorize_above_limit:true},db),errorCode('ADMIN_AUTHORIZATION_REQUIRED'));
      await assert.rejects(create(admin,request,db),errorCode('ADMIN_AUTHORIZATION_REQUIRED'));
      await assert.rejects(create(admin,{...request,authorize_above_limit:'true'},db),errorCode('INVALID_AUTHORIZATION'));
      const result=await create({...admin,role:'sub_admin'},{...request,authorize_above_limit:true},db);
      assert.equal(result.transfer.authorized_by,1);assert.ok(result.transfer.authorized_at);assert.equal(result.transfer.approval_limit,'50.00');
      const bulk=await fixturePair(db,{credits:['30.00','30.00']});
      await assert.rejects(create(staff,{...bulk.request,authorize_above_limit:true},db),errorCode('ADMIN_AUTHORIZATION_REQUIRED'));
      const bulkResult=await create(admin,{...bulk.request,authorize_above_limit:true},db);
      assert.equal(bulkResult.transfer.amount,'60.00');assert.equal(bulkResult.transfer.authorized_by,1);
      await updateTransferSettings(admin,{approval_limit:'50000'},db);
    });
    await t.test('partial allocations, repeated selection, cash/bank composition, and onward transfer stay exact',async()=>{
      const {source,destination,entries,request}=await fixturePair(db,{credits:['0.10','0.20','10.00'],modes:['cash','cash','bank']});
      const first=await create(staff,{...request,amount:'0.15'},db);
      assert.deepEqual(first.transfer.allocations.map(a=>a.amount),['0.10','0.05']);
      const eligible=await transferEligibility(staff,{source_ledger_id:source.id,entry_ids:entries.map(e=>e.id).join(',')},db);
      assert.equal(eligible.entries[0].eligible,false);assert.equal(eligible.entries[1].transferable_amount,'0.15');
      await assert.rejects(create(staff,{...request,idempotency_key:randomUUID(),amount:'0.01'},db),errorCode('INELIGIBLE_TRANSACTION'));
      const second=await create(staff,{...request,source_transaction_ids:entries.slice(1).map(e=>e.id),idempotency_key:randomUUID()},db);
      assert.equal(second.transfer.amount,'10.15');assert.equal(second.transfer.entries.length,4);
      assert.equal(await ledgerFunds(db,source.id),'0.00');assert.equal(await ledgerFunds(db,destination.id),'10.30');
      const onward=await fixtureLedger(db,{site:11});
      const creditId=first.transfer.entries.find(e=>e.money_transfer_leg==='credit').id;
      await create(staff,{source_ledger_id:destination.id,destination_ledger_id:onward.id,source_transaction_ids:[creditId],idempotency_key:randomUUID()},db);
      assert.equal(await ledgerFunds(db,destination.id),'10.15');assert.equal(await ledgerFunds(db,onward.id),'0.15');
    });
    await t.test('source availability and payment-mode coverage cannot be overridden by admin authorization',async()=>{
      const low=await fixturePair(db);
      await fixtureEntry(db,low.source,{credit:'0',debit:'90'});
      await assert.rejects(create(admin,{...low.request,authorize_above_limit:true},db),errorCode('INSUFFICIENT_SOURCE_BALANCE'));
      await assert.rejects(create(admin,{...low.request,amount:'101',authorize_above_limit:true},db),errorCode('AMOUNT_EXCEEDS_SELECTION'));
      const mixed=await fixturePair(db,{credits:['100','100'],modes:['cash','bank']});
      await fixtureEntry(db,mixed.source,{credit:'0',debit:'90',mode:'cash'});
      await assert.rejects(create(admin,{...mixed.request,source_transaction_ids:[mixed.entries[0].id]},db),errorCode('INSUFFICIENT_PAYMENT_MODE_BALANCE'));
      for(const amount of ['0','-1','0.001']) await assert.rejects(create(admin,{...mixed.request,amount},db),errorCode('INVALID_AMOUNT'));
    });
    await t.test('cross-site cash respects existing wallet and Imprest reservations even with admin authorization',async()=>{
      const {request,source,destination}=await fixturePair(db,{site:11});
      await db.query(`INSERT INTO test_site_reservations(site_id,amount)
        SELECT 10,imprest_available_site_cash(10)+1 ON CONFLICT(site_id) DO UPDATE SET amount=EXCLUDED.amount`);
      await assert.rejects(create(admin,{...request,authorize_above_limit:true},db),errorCode('INSUFFICIENT_SITE_CASH'));
      assert.equal(await ledgerFunds(db,source.id),'100.00');assert.equal(await ledgerFunds(db,destination.id),'0.00');
      await db.query('DELETE FROM test_site_reservations WHERE site_id=10');
      await create(admin,{...request,authorize_above_limit:true},db);
    });
    await t.test('cross-site bank transfers require site-wide bank coverage despite a positive source ledger',async()=>{
      const {request,source,destination}=await fixturePair(db,{site:11,credits:['100.00'],modes:['bank']});
      const other=await fixtureLedger(db);
      const available=(await db.query("SELECT COALESCE(sum(credit-debit),0)::text AS balance FROM ledger_entries WHERE site_id=10 AND bucket='bank'")).rows[0].balance;
      const payment=await fixtureEntry(db,other,{credit:'0',debit:moneyDecimal(moneyMinor(available)+1n),mode:'bank'});
      assert.equal(await ledgerFunds(db,source.id),'100.00');
      await assert.rejects(create(admin,{...request,authorize_above_limit:true},db),errorCode('INSUFFICIENT_SITE_BANK'));
      assert.equal(await ledgerFunds(db,destination.id),'0.00');
      await db.query('DELETE FROM cash_flow_entries WHERE id=$1',[payment.id]);
      assert.equal((await create(admin,{...request,authorize_above_limit:true},db)).transfer.amount,'100.00');
    });
    await t.test('eligibility excludes unapproved, reversed, future, uncleared, mirrored and legacy-allocated receipts',async()=>{
      const {source,destination}=await fixturePair(db,{credits:[]});
      const variants=[{status:'pending'},{status:'rejected'},{credit:'0',debit:'10'},
        {mode:'cheque',cheque:'PENDING'},{mode:'cheque',cheque:'BOUNCED'},
        {source:'expenses_person'},{source:'plot_registry_payments'},
        {extra:{is_reversed:true}},{extra:{reversed_at:'2026-01-01'}},{extra:{date:'2099-01-01'}},
        {extra:{entry_transfer_id:randomUUID()}}];
      const rows=[];for(const variant of variants) rows.push(await fixtureEntry(db,source,variant));
      const legacy=await fixtureEntry(db,source);rows.push(legacy);
      await db.query("INSERT INTO transaction_money_transfers VALUES($1,'personal_ledger',$2)",[randomUUID(),legacy.id]);
      const good=await fixtureEntry(db,source,{mode:'cheque',cheque:'CLEARED'});
      const result=await transferEligibility(admin,{source_ledger_id:source.id},db);
      assert.equal(result.entries.find(e=>e.id===good.id).eligible,true);
      assert.ok(rows.every(row=>result.entries.find(e=>e.id===row.id).eligible===false));
      for(const row of rows) await assert.rejects(create(admin,{source_ledger_id:source.id,destination_ledger_id:destination.id,source_transaction_ids:[row.id],idempotency_key:randomUUID()},db),errorCode('INELIGIBLE_TRANSACTION'));
    });
    await t.test('locked/rolled-forward ledgers and invalid or unauthorized destinations are denied',async()=>{
      const {source,destination,request}=await fixturePair(db,{site:11});
      await assert.rejects(create({id:3},request,db),errorCode('LEDGER_NOT_FOUND'));
      await assert.rejects(create({id:4},request,db),errorCode('LEDGER_NOT_FOUND'));
      await assert.rejects(create({id:6},request,db),errorCode('TRANSFER_FORBIDDEN'));
      await assert.rejects(create({id:7},request,db),errorCode('TRANSFER_FORBIDDEN'));
      await assert.rejects(create(admin,{...request,destination_ledger_id:2147483647},db),errorCode('LEDGER_NOT_FOUND'));
      await assert.rejects(create(admin,{...request,destination_ledger_id:source.id},db),errorCode('SAME_LEDGER'));
      await assert.rejects(create(admin,{...request,source_transaction_ids:[]},db),errorCode('INVALID_SELECTION'));
      await assert.rejects(create(admin,{...request,source_transaction_ids:[request.source_transaction_ids[0],request.source_transaction_ids[0]]},db),errorCode('INVALID_SELECTION'));
      const foreignReceipt=await fixtureEntry(db,destination);
      await assert.rejects(create(admin,{...request,source_transaction_ids:[foreignReceipt.id]},db),errorCode('INELIGIBLE_TRANSACTION'));
      await db.query('UPDATE cash_flow_months SET is_locked=true WHERE id=$1',[destination.id]);
      await assert.rejects(create(admin,request,db),errorCode('LEDGER_UNAVAILABLE'));
      await db.query('UPDATE cash_flow_months SET is_locked=false WHERE id=$1',[destination.id]);
      await fixtureLedger(db,{name:source.ledger_name,year:2027});
      assert.equal((await transferEligibility(admin,{source_ledger_id:source.id},db)).can_transfer,false);
      await assert.rejects(create(admin,request,db),errorCode('LEDGER_UNAVAILABLE'));
      const fresh=await fixturePair(db),future=await fixtureLedger(db,{year:2099});
      await assert.rejects(create(admin,{...fresh.request,destination_ledger_id:future.id},db),errorCode('LEDGER_UNAVAILABLE'));
    });
    await t.test('duplicate submissions replay once and changed requests fail without a second credit',async()=>{
      const {request,destination}=await fixturePair(db,{credits:['30.02']});
      const results=await Promise.all(Array.from({length:12},()=>create(staff,request,db)));
      assert.equal(new Set(results.map(r=>r.transfer.id)).size,1);assert.equal(results.filter(r=>!r.replayed).length,1);
      assert.equal(await ledgerFunds(db,destination.id),'30.02');
      await assert.rejects(create(staff,{...request,amount:'10'},db),errorCode('IDEMPOTENCY_CONFLICT'));
    });
    await t.test('failure after debit rolls back transfer, allocations, entries and audit; retry uses the same key',async()=>{
      const {source,destination,request}=await fixturePair(db);
      const before=await organizationFunds(db),counts=(await db.query('SELECT count(*)::int AS n FROM cashflow_transfers')).rows[0].n;
      await db.query(`CREATE FUNCTION fail_test_transfer_credit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.money_transfer_leg='credit' THEN RAISE EXCEPTION 'Injected destination failure'; END IF; RETURN NEW; END $$;
        CREATE TRIGGER fail_test_transfer_credit BEFORE INSERT ON cash_flow_entries FOR EACH ROW EXECUTE FUNCTION fail_test_transfer_credit();`);
      await cacheSet('cashflow|rollback-proof',{value:'original'},60);const generation=getCacheGeneration();
      await assert.rejects(create(staff,request,db),/Injected destination failure/);
      assert.equal(await ledgerFunds(db,source.id),'100.00');assert.equal(await ledgerFunds(db,destination.id),'0.00');
      assert.equal(await organizationFunds(db),before);assert.equal((await db.query('SELECT count(*)::int AS n FROM cashflow_transfers')).rows[0].n,counts);
      assert.equal(getCacheGeneration(),generation);assert.deepEqual(await cacheGet('cashflow|rollback-proof'),{value:'original'});
      await db.query('DROP TRIGGER fail_test_transfer_credit ON cash_flow_entries; DROP FUNCTION fail_test_transfer_credit()');
      await create(staff,request,db);assert.equal(await cacheGet('cashflow|rollback-proof'),null);
    });
    await t.test('completed records, source receipts, headers, audit and ledger identity are immutable',async()=>{
      const {source,entries,request}=await fixturePair(db);
      const {transfer}=await create(staff,{...request,amount:'10'},db);
      const entry=transfer.entries[0];
      for(const [sql,args] of [
        ['UPDATE cashflow_transfers SET remarks=$2 WHERE id=$1',[transfer.id,'changed']],
        ['DELETE FROM cashflow_transfers WHERE id=$1',[transfer.id]],
        ['DELETE FROM cashflow_transfer_allocations WHERE transfer_id=$1',[transfer.id]],
        ['DELETE FROM cashflow_transfer_audit WHERE transfer_id=$1',[transfer.id]],
        ['UPDATE cash_flow_entries SET credit=0 WHERE id=$1',[entries[0].id]],
        ['DELETE FROM cash_flow_entries WHERE id=$1',[entry.id]],
        ['UPDATE cash_flow_months SET opening_balance=1000 WHERE id=$1',[source.id]],
        ["INSERT INTO transaction_money_transfers VALUES($1,'personal_ledger',$2)",[randomUUID(),entries[0].id]],
      ]) await assert.rejects(db.query(sql,args),error=>error.code==='23514');
      await assert.rejects(down(db),/completed transfers must retain/);
    });
    await t.test('database rejects an unmatched accounting leg even if a caller bypasses the service',async()=>{
      const {request,source,destination}=await fixturePair(db);
      const {transfer}=await create(staff,request,db);
      for(const [sourceModule,leg] of [['cashflow_transfers',null],[null,'debit']]) {
        await assert.rejects(db.query(`INSERT INTO cash_flow_entries(cash_flow_month_id,site_id,particular,debit,credit,cash_type,status,source_module,money_transfer_id,money_transfer_leg,created_by)
          VALUES($1,$2,'Forged nullable transfer link',1,0,'bank','approved',$3,$4,$5,2)`,[source.id,source.site_id,sourceModule,transfer.id,leg]),
          error=>error.code==='23514'&&error.constraint==='cashflow_money_transfer_link');
      }
      await assert.rejects(db.query(`INSERT INTO cash_flow_entries(cash_flow_month_id,site_id,particular,debit,credit,cash_type,status,source_module,money_transfer_id,money_transfer_leg,created_by)
        VALUES($1,$2,'Unauthorized extra leg',1,0,'bank','approved','cashflow_transfers',$3,'debit',2)`,[source.id,source.site_id,transfer.id]),error=>error.code==='23514');
      assert.equal(await ledgerFunds(db,destination.id),'100.00');
      const id=randomUUID();
      await assert.rejects(db.query(`INSERT INTO cashflow_transfers
        SELECT $1,'CFT-test-unbalanced',$2,source_site_id,source_ledger_id,destination_site_id,destination_ledger_id,
        amount,transfer_type,currency,status,source_transaction_ids,remarks,initiated_by,authorized_by,authorized_at,approval_limit,
        created_at,completed_at,$3,request_hash,source_balance_before,source_balance_after,destination_balance_before,destination_balance_after
        FROM cashflow_transfers WHERE id=$4`,[id,1,randomUUID(),transfer.id]),error=>error.code==='23514');
    });
    await t.test('search, history filters, keyset pagination, and detail enforce both site grants',async()=>{
      const {source,request}=await fixturePair(db,{site:11});const {transfer}=await create(staff,request,db);
      const destinations=await transferDestinations(staff,{source_ledger_id:source.id,site_id:11,q:'Ledger',limit:2},db);
      assert.ok(destinations.ledgers.length<=2);assert.ok(destinations.sites.every(s=>s.id!==20));assert.ok(destinations.next_cursor);
      await assert.rejects(transferDestinations({id:3},{source_ledger_id:source.id,site_id:11},db),errorCode('TRANSFER_FORBIDDEN'));
      const filtered=await listCashflowTransfers(staff,{ledger_id:source.id,type:'cross_site'},db);
      assert.equal(filtered.transfers.length,1);assert.equal(filtered.transfers[0].id,transfer.id);
      assert.equal((await getCashflowTransfer(staff,transfer.id,db)).transfer.entries.length,2);
      await assert.rejects(getCashflowTransfer({id:3},transfer.id,db),errorCode('TRANSFER_NOT_FOUND'));
      const first=await listCashflowTransfers(admin,{limit:3},db),second=await listCashflowTransfers(admin,{limit:3,cursor:first.next_cursor},db);
      assert.equal(first.transfers.length,3);assert.equal(second.transfers.length,3);
      assert.ok(second.transfers.every(row=>!first.transfers.some(other=>other.id===row.id)));
      await assert.rejects(listCashflowTransfers(admin,{start_date:'2026-02-30'},db),errorCode('INVALID_DATE'));
      await assert.rejects(listCashflowTransfers(admin,{cursor:'invalid'},db),errorCode('INVALID_CURSOR'));
    });
  } finally { await close(); }
});
