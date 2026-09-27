import test from 'node:test';
import assert from 'node:assert/strict';
import {parseYearEndScope,validateRequirementUpdate,getYearEndReport,REQUIREMENT_IDS,YEAR_END_QUERIES} from '../src/services/yearEndRequirements.service.js';
import {collectYearEndDocuments,safeFilePart} from '../src/services/yearEndDocuments.service.js';

test('scope validates strict identifiers and creates the Indian financial year',()=>{
  assert.deepEqual(parseYearEndScope({site_id:'4',financial_year:'2025',loan_ledger_ids:'2,5,2'}),{siteId:4,year:2025,from:'2025-04-01',to:'2026-03-31',loanIds:[2,5]});
  for(const query of [{site_id:'4junk',financial_year:'2025'},{site_id:'-1',financial_year:'2025'},{site_id:'1',financial_year:'2025-26'},{site_id:'1',financial_year:'2025',loan_ledger_ids:'1,2 OR 1=1'}]) assert.throws(()=>parseYearEndScope(query),{statusCode:400});
});

test('checklist accepts only known statuses, bounded notes and all 14 requirements',()=>{
  assert.equal(REQUIREMENT_IDS.length,14);
  assert.deepEqual(validateRequirementUpdate({requirement:'tax_review',status:'in_progress',notes:' Pending accountant review '}),{requirement:'tax_review',status:'in_progress',notes:'Pending accountant review'});
  assert.throws(()=>validateRequirementUpdate({requirement:'sql',status:'complete',notes:''}));
  assert.throws(()=>validateRequirementUpdate({requirement:'loans',status:'paid',notes:''}));
  assert.throws(()=>validateRequirementUpdate({requirement:'loans',status:'complete',notes:'x'.repeat(4001)}));
});

test('document collection enforces permissions, financial year and registry filename dates',()=>{
  const report={site:{id:4,name:'Selected site'},period:{financial_year:2025},selectedLoanIds:[],loanAccounts:[],bills:[],reports:{registries:{rows:[{id:9,plot_id:3,party:'Party / One',plot_no:'A/1',firm:'Firm A',registry_date:'2025-08-13'}]},land_purchases:{rows:[]}},documents:[
    {id:1,plot_id:3,category:'REGISTRY',original_name:'deed.pdf',file_path:'key'},
    {id:2,farmer_id:5,category:'AGREEMENT',original_name:'mou.pdf',file_path:'private'},
    {id:3,entity_type:'balance_sheet_requirement',metadata:{requirement:'registries',financial_year:2024},original_name:'old.pdf'},
    {id:4,entity_type:'balance_sheet_requirement',metadata:{requirement:'registries',financial_year:2025,party:'Party B',firm:'Forged owner'},date:'2025-04-02',original_name:'new.pdf'},
  ]};
  const documents=collectYearEndDocuments(report,new Set(['registries']));
  assert.equal(documents.length,2);
  assert.equal(documents[0].download_name,'2025-08-13_Party _ One_Plot-A_1_1.pdf');
  assert.ok(documents.every(document=>document.site_id===4 && document.site_name==='Selected site'));
  assert.ok(documents.every(document=>!Object.hasOwn(document,'firm')));
  assert.equal(documents[1].download_name,'2025-04-02_Party B_4.pdf');
  assert.ok(!safeFilePart('../outside\n/escape').includes('/'));
  assert.ok(!safeFilePart('../outside\n/escape').includes('..'));
  report.reports.registries.rows.push({...report.reports.registries.rows[0],id:10,registry_date:'2025-10-01',party:'Another buyer'});
  const ambiguous=collectYearEndDocuments(report,new Set(['registries']));
  assert.ok(ambiguous[0].download_name.startsWith('Registry-date-needs-review_'));
  assert.ok(!ambiguous[0].download_name.includes('Party _ One'));
});

test('repeatable report skips restricted queries and preserves account opening balances',async()=>{
  const calls=[];
  const db={query:async(sql,params)=>{
    calls.push({sql,params});
    if(sql.startsWith('SELECT id,name,code')) return {rows:[{id:4,name:'Example site'}]};
    if(sql.startsWith('SELECT id,COALESCE')) return {rows:[{id:2,name:'Loan A',opening_balance:'100.25'}]};
    if(sql.startsWith('WITH posted')) return {rows:[{id:9,ledger_id:2,ledger:'Loan A',date:'2025-01-01',paid:'0',received:'50.00',balance:'150.25'}]};
    if(sql.includes("to_regclass('public.balance_sheet_requirements')")) return {rows:[{ready:true}]};
    if(sql.includes('FROM balance_sheet_requirements')) return {rows:[{requirement:'loans',status:'pending'},{requirement:'payment_kyc',notes:'private'}]};
    return {rows:[]};
  },release:()=>calls.push({sql:'RELEASE'})};
  const result=await getYearEndReport(parseYearEndScope({site_id:'4',financial_year:'2025',loan_ledger_ids:'2'}),new Set(['loans']),{connect:async()=>db});
  assert.equal(result.reports.loans.rows[0].balance,'100.25');
  assert.equal(result.reports.loans.rows[1].date,'2025-01-01');
  assert.equal(result.reports.payment_kyc.restricted,true);
  assert.equal(result.checklist.length,1);
  assert.ok(!calls.some(call=>call.sql.includes('WITH payments AS')));
  assert.ok(calls.some(call=>call.sql==='BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'));
  assert.equal(calls.at(-2).sql,'COMMIT');
  assert.equal(calls.at(-1).sql,'RELEASE');
});

test('loan selections from another site are rejected and the snapshot is rolled back',async()=>{
  const calls=[];
  const db={query:async sql=>{calls.push(sql);return {rows:sql.startsWith('SELECT id,name,code')?[{id:1}]:[]};},release:()=>calls.push('RELEASE')};
  await assert.rejects(getYearEndReport(parseYearEndScope({site_id:'1',financial_year:'2025',loan_ledger_ids:'9'}),new Set(['loans']),{connect:async()=>db}),{statusCode:400});
  assert.deepEqual(calls.slice(-2),['ROLLBACK','RELEASE']);
});

test('financial schedules use the posting policy, cutoff and no trigger mirror double count',()=>{
  assert.match(YEAR_END_QUERIES.registries,/financial_transaction_posts\('credit',pp.status,pp.payment_type,pp.cheque_status\)/);
  assert.match(YEAR_END_QUERIES.registries,/pp\.date END\) BETWEEN DATE '1900-01-01' AND \$3::date/);
  assert.match(YEAR_END_QUERIES.farmer_balances,/le\.debit-le\.credit/);
  assert.match(YEAR_END_QUERIES.farmer_balances,/le\.bucket<>'cash'/);
  assert.match(YEAR_END_QUERIES.firm_balances,/FROM sites s LEFT JOIN ledger_entries le/);
  assert.match(YEAR_END_QUERIES.inter_firm,/t.counterparty_site_id<>\$1/);
});
