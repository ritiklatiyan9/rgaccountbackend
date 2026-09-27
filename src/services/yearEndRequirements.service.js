import pool from '../config/db.js';

export const REQUIREMENT_IDS = Object.freeze(['registries', 'remaining_plots', 'payment_kyc', 'tax_review', 'land_purchases', 'farmer_mous', 'farmer_balances', 'purchase_bills', 'loans', 'bank_accounts', 'firm_balances', 'inter_firm', 'partner_payments', 'tds_reference']);
export const REPORT_PERMISSIONS = Object.freeze({
  registries: ['plot_registry'], remaining_plots: ['plot_payments', 'plot_registry'],
  payment_kyc: ['commissions', 'expenses', 'clients'], land_purchases: ['farmers'],
  farmer_mous: ['farmers'], farmer_balances: ['farmers'], purchase_bills: ['expenses'],
  loans: ['cashflow'], bank_accounts: ['daybook'], firm_balances: ['firm_transactions'], firm_ledger: ['firm_transactions'],
  inter_firm: ['firm_transactions'], partner_payments: ['daybook', 'clients', 'cashflow', 'expenses', 'firm_transactions', 'commissions', 'farmers'],
});

const invalid = message => { throw Object.assign(new Error(message), { statusCode: 400 }); };
export function parseYearEndScope(query) {
  const siteId = Number(query.site_id);
  const year = Number(query.financial_year);
  if (!/^\d+$/.test(String(query.site_id)) || !Number.isSafeInteger(siteId) || siteId < 1 || siteId > 2147483647) invalid('A valid site_id is required.');
  if (!/^\d{4}$/.test(String(query.financial_year)) || year < 1900 || year > 2099) invalid('financial_year must be the starting year, from 1900 to 2099.');
  const ids = query.loan_ledger_ids ? String(query.loan_ledger_ids).split(',') : [];
  if (ids.length > 100 || ids.some(id => !/^\d+$/.test(id) || Number(id) < 1 || Number(id) > 2147483647)) invalid('Select up to 100 valid loan ledgers.');
  return { siteId, year, from: `${year}-04-01`, to: `${year + 1}-03-31`, loanIds: [...new Set(ids.map(Number))] };
}

export function validateRequirementUpdate(body) {
  if (!REQUIREMENT_IDS.includes(body.requirement)) invalid('Unknown requirement.');
  if (!['pending', 'in_progress', 'complete', 'not_applicable'].includes(body.status)) invalid('Choose a valid checklist status.');
  if (typeof body.notes !== 'string' || body.notes.length > 4000) invalid('Notes must contain at most 4,000 characters.');
  return { requirement: body.requirement, status: body.status, notes: body.notes.trim() };
}

// Receipts use their effective source date/mode and posting policy. Registry
// allocations are coverage only: they must never be added to site cash flow.
const REGISTRIES = `SELECT pr.id, COALESCE(pr.plot_id,p.id) AS plot_id, COALESCE(NULLIF(pr.firm_name,''), 'Unassigned firm') AS firm,
  COALESCE(NULLIF(p.buyer_name,''), pr.customer_name) AS party, pr.plot_no,
  pr.registry_date::text AS registry_date, pr.bank_amount AS bank_due,
  COALESCE(paid.bank_received,0) AS bank_received,
  CASE WHEN pr.bank_amount IS NULL THEN NULL ELSE pr.bank_amount - COALESCE(paid.bank_received,0) END AS balance,
  CASE WHEN pr.bank_amount IS NULL THEN 'Bank amount missing'
    WHEN COALESCE(paid.bank_received,0) >= pr.bank_amount THEN 'Received'
    WHEN COALESCE(paid.bank_received,0) > 0 THEN 'Part received' ELSE 'Not received' END AS receipt_status,
  COALESCE(p.plot_size_mtr, pr.size_meter, ROUND((CASE WHEN p.unit_type='flat' THEN p.plot_size/9 ELSE p.plot_size END)*0.8364,2)) AS size_mtr,
  COALESCE(CASE WHEN p.unit_type='flat' THEN p.plot_size/9 ELSE p.plot_size END, pr.size_sqyard) AS size_yards
 FROM plot_registries pr LEFT JOIN LATERAL (SELECT source.* FROM plots source WHERE source.site_id=pr.site_id
   AND (source.id=pr.plot_id OR (pr.plot_id IS NULL AND UPPER(source.plot_no)=UPPER(pr.plot_no)
     AND UPPER(COALESCE(source.plot_tag,''))<>'OLD')) ORDER BY source.id DESC LIMIT 1) p ON TRUE
 LEFT JOIN LATERAL (
   SELECT SUM(prp.amount) AS bank_received FROM plot_registry_payments prp
   LEFT JOIN plot_payments pp ON pp.id=prp.source_plot_payment_id AND pp.site_id=pr.site_id
   WHERE prp.registry_id=pr.id AND prp.site_id=pr.site_id
     AND (CASE WHEN prp.source_plot_payment_id IS NULL THEN prp.payment_date ELSE pp.date END) BETWEEN DATE '1900-01-01' AND $3::date
     AND ledger_bucket(CASE WHEN prp.source_plot_payment_id IS NULL THEN prp.payment_mode ELSE pp.payment_type END) <> 'cash'
     AND ((prp.source_plot_payment_id IS NULL AND financial_transaction_posts('credit',prp.status,prp.payment_mode,prp.cheque_status))
       OR (prp.source_plot_payment_id IS NOT NULL AND financial_transaction_posts('credit',pp.status,pp.payment_type,pp.cheque_status)
         AND (pp.plot_id=pr.plot_id OR (pr.plot_id IS NULL AND EXISTS (SELECT 1 FROM plots target
           WHERE target.id=pp.plot_id AND target.site_id=pr.site_id AND UPPER(target.plot_no)=UPPER(pr.plot_no))))))
 ) paid ON TRUE WHERE pr.site_id=$1 AND pr.registry_date BETWEEN $2::date AND $3::date
 ORDER BY firm, pr.registry_date, pr.id`;

const REMAINING = `SELECT p.id, COALESCE(NULLIF(r.firm_name,''),'Unassigned firm') AS firm, p.plot_no, p.block, p.status,
 CASE WHEN p.unit_type='flat' THEN p.plot_size/9 ELSE p.plot_size END AS size_yards,
 COALESCE(p.plot_size_mtr,ROUND((CASE WHEN p.unit_type='flat' THEN p.plot_size/9 ELSE p.plot_size END)*0.8364,2)) AS size_mtr,
 COALESCE(r.registry_payment, p.registry_area*p.circle_rate) AS registry_value,
 'Current inventory; verify year-end position'::text AS review
 FROM plots p LEFT JOIN LATERAL (SELECT * FROM plot_registries pr WHERE pr.site_id=p.site_id
   AND (pr.plot_id=p.id OR (pr.plot_id IS NULL AND UPPER(pr.plot_no)=UPPER(p.plot_no))) ORDER BY pr.id DESC LIMIT 1) r ON TRUE
 WHERE p.site_id=$1 AND COALESCE(p.booking_date,p.created_at::date) <= $3::date
   AND $2::date IS NOT NULL AND UPPER(TRIM(COALESCE(p.plot_tag,'')))<>'OLD'
   AND NOT EXISTS (SELECT 1 FROM plot_registries pr WHERE pr.site_id=p.site_id
     AND (pr.plot_id=p.id OR (pr.plot_id IS NULL AND UPPER(pr.plot_no)=UPPER(p.plot_no))) AND pr.registry_date <= $3::date)
 ORDER BY firm, p.block, p.plot_no, p.id`;

const PAYMENT_KYC = `WITH payments AS (
 SELECT le.id, le.entry_date, COALESCE(pcp.mapped_member_id,pc.agent_id) AS member_id,
   le.entity_name AS party, 'Commission'::text AS nature, le.debit-le.credit AS amount
 FROM ledger_entries le JOIN plot_commission_payments pcp ON le.source_key='plot_commission_payments' AND pcp.id=le.source_id
 JOIN plot_commissions_v2 pc ON pc.id=pcp.plot_commission_id
 WHERE le.site_id=$1 AND le.entry_date BETWEEN $2::date AND $3::date
 UNION ALL
 SELECT le.id,le.entry_date,e.mapped_member_id, COALESCE(NULLIF(e.to_entity,''),le.entity_name),
 CASE WHEN CONCAT_WS(' ',e.category,e.sub_category) ~* 'commission' THEN 'Commission' ELSE 'Labour' END, le.debit-le.credit
 FROM ledger_entries le JOIN expenses e ON le.source_key='expenses' AND e.id=le.source_id
 WHERE le.site_id=$1 AND le.entry_date BETWEEN $2::date AND $3::date
   AND CONCAT_WS(' ',e.category,e.sub_category) ~* '(labou?r|commission|mistri|mazdoor|मजदूर|मजदूरी)'
 ) SELECT p.id, p.entry_date::text AS date, COALESCE(m.full_name,p.party) AS party, p.nature,p.amount,
 m.pan_no AS pan, m.aadhar_no AS aadhaar,
 CASE WHEN m.id IS NULL THEN 'Recipient mapping missing' WHEN NULLIF(TRIM(m.pan_no),'') IS NULL OR NULLIF(TRIM(m.aadhar_no),'') IS NULL THEN 'KYC incomplete' ELSE 'Available' END AS review
 FROM payments p LEFT JOIN members m ON m.id=p.member_id AND m.site_id=$1
 ORDER BY party,p.entry_date,p.id`;

const FARMER_BALANCES = `SELECT f.id,f.name AS farmer,f.total_amount,
 CASE WHEN UPPER(f.payment_mode)='CASH' THEN 0 WHEN UPPER(f.payment_mode)='BANK' THEN f.total_amount ELSE f.bank_amount END AS bank_due,
 COALESCE(paid.bank_paid,0) AS bank_paid,
 (CASE WHEN UPPER(f.payment_mode)='CASH' THEN 0 WHEN UPPER(f.payment_mode)='BANK' THEN f.total_amount ELSE f.bank_amount END)-COALESCE(paid.bank_paid,0) AS balance
 FROM farmers f LEFT JOIN LATERAL (SELECT SUM(le.debit-le.credit) AS bank_paid
   FROM ledger_entries le JOIN farmer_payments fp ON le.source_key='farmer_payments' AND fp.id=le.source_id
   WHERE fp.farmer_id=f.id AND le.site_id=f.site_id AND le.bucket<>'cash' AND le.entry_date <= $3::date) paid ON TRUE
 WHERE f.site_id=$1 AND $2::date IS NOT NULL
 ORDER BY f.name,f.id`;

const LAND = `SELECT ld.id, f.id AS farmer_id, f.name AS farmer,ld.deal_no,ld.purchase_date::text AS date,
 ld.area_bigha,ld.area_gaz AS size_yards,ld.area_mtr AS size_mtr,ld.purchase_cost,ld.status,ld.notes,
 'Confirm purchased portion against signed MOU'::text AS review
 FROM land_deals ld LEFT JOIN farmers f ON f.id=ld.farmer_id AND f.site_id=ld.site_id
 WHERE ld.site_id=$1 AND ld.purchase_date BETWEEN $2::date AND $3::date AND ld.status<>'cancelled'
 ORDER BY ld.purchase_date,ld.id`;

const BANKS = `SELECT id,COALESCE(NULLIF(account_holder,''),'Unassigned firm') AS firm,name AS bank,
 account_no,ifsc,branch,CASE WHEN is_active THEN 'Active' ELSE 'Inactive' END AS status
 FROM bank_accounts WHERE site_id=$1 AND $2::date IS NOT NULL AND $3::date IS NOT NULL ORDER BY firm,name,id`;

// Firm books contain direct transactions and Day Book firm mappings. Exclude
// trigger mirrors of firm_transactions from the second leg to count each once.
const FIRM_ENTRIES = `WITH entries AS (
 SELECT ft.id::text AS id,ft.firm_id,ft.date,ft.description AS particular,ft.name AS party,
 CASE WHEN financial_transaction_posts('debit',ft.status,ft.payment_mode,ft.cheque_status) THEN ft.debit ELSE 0 END AS debit,
 CASE WHEN financial_transaction_posts('credit',ft.status,ft.payment_mode,ft.cheque_status) THEN ft.credit ELSE 0 END AS credit,
 ft.is_firm_to_firm_transfer AS inter_firm,ft.transfer_group_id AS reference,ft.purpose
 FROM firm_transactions ft WHERE ft.site_id=$1 AND ft.date BETWEEN DATE '1900-01-01' AND $3::date
 UNION ALL
 SELECT CONCAT('mapped-',c.id,'-',f.id),f.id,c.date,c.particular,
 CASE WHEN f.id=c.from_firm_id THEN dest.name ELSE origin.name END,
 CASE WHEN f.id=c.from_firm_id AND financial_transaction_posts('debit',c.status,c.cash_type,c.cheque_status) THEN COALESCE(c.debit,0)+COALESCE(c.credit,0) ELSE 0 END,
 CASE WHEN f.id=c.to_firm_id AND financial_transaction_posts('credit',c.status,c.cash_type,c.cheque_status) THEN COALESCE(c.debit,0)+COALESCE(c.credit,0) ELSE 0 END,
 c.from_firm_id IS NOT NULL AND c.to_firm_id IS NOT NULL,CONCAT('daybook-',c.id),c.remarks
 FROM cash_flow_entries c JOIN firms f ON f.id IN (c.from_firm_id,c.to_firm_id) AND f.site_id=$1
 LEFT JOIN firms origin ON origin.id=c.from_firm_id LEFT JOIN firms dest ON dest.id=c.to_firm_id
 WHERE c.site_id=$1 AND c.is_firm_transaction=TRUE AND COALESCE(c.source_module,'')<>'firm_transactions'
 AND COALESCE(c.source_module,'') !~ '_person$' AND c.date BETWEEN DATE '1900-01-01' AND $3::date
 )`;

const FIRMS = `${FIRM_ENTRIES} SELECT f.id,f.name AS firm,
 COALESCE(f.opening_balance,0)+COALESCE(SUM(e.credit-e.debit) FILTER (WHERE e.date<$2::date),0) AS opening,
 COALESCE(SUM(e.credit) FILTER (WHERE e.date >= $2::date),0) AS received,
 COALESCE(SUM(e.debit) FILTER (WHERE e.date >= $2::date),0) AS paid,
 COALESCE(f.opening_balance,0)+COALESCE(SUM(e.credit-e.debit),0) AS balance
 FROM firms f LEFT JOIN entries e ON e.firm_id=f.id WHERE f.site_id=$1 GROUP BY f.id,f.name,f.opening_balance ORDER BY f.name,f.id`;
const INTER_FIRM = `${FIRM_ENTRIES} SELECT e.id,f.name AS firm,e.date::text AS date,e.party,e.particular,
 e.debit AS paid,e.credit AS received,e.reference,e.purpose,
 SUM(e.credit-e.debit) OVER (PARTITION BY e.firm_id,COALESCE(e.party,'') ORDER BY e.date,e.id ROWS UNBOUNDED PRECEDING) AS balance
 FROM entries e JOIN firms f ON f.id=e.firm_id WHERE e.inter_firm AND (e.debit<>0 OR e.credit<>0) AND $2::date IS NOT NULL
 ORDER BY f.name,e.party,e.date,e.id`;
const FIRM_LEDGER = `${FIRM_ENTRIES} SELECT e.id,f.name AS firm,e.date::text AS date,e.party,e.particular,
 e.debit AS paid,e.credit AS received,e.purpose,
 COALESCE(f.opening_balance,0)+SUM(e.credit-e.debit) OVER (PARTITION BY e.firm_id ORDER BY e.date,e.id ROWS UNBOUNDED PRECEDING) AS balance
 FROM entries e JOIN firms f ON f.id=e.firm_id WHERE (e.debit<>0 OR e.credit<>0) AND $2::date IS NOT NULL ORDER BY f.name,e.date,e.id`;

const LOAN_ACCOUNTS = `SELECT id,COALESCE(NULLIF(ledger_name,''),CONCAT('Ledger ',id)) AS name,ledger_type,opening_balance
 FROM cash_flow_months WHERE site_id=$1 AND ledger_type<>'site' AND $2::date IS NOT NULL AND $3::date IS NOT NULL ORDER BY ledger_name,id`;
const LOANS = `WITH posted AS (SELECT c.id,c.cash_flow_month_id,c.date,c.particular,c.cash_type,
 CASE WHEN financial_transaction_posts('debit',c.status,c.cash_type,c.cheque_status) THEN COALESCE(c.debit,0) ELSE 0 END AS paid,
 CASE WHEN financial_transaction_posts('credit',c.status,c.cash_type,c.cheque_status) THEN COALESCE(c.credit,0) ELSE 0 END AS received
 FROM cash_flow_entries c WHERE c.site_id=$1 AND c.cash_flow_month_id=ANY($4::int[])
 AND c.date BETWEEN DATE '1900-01-01' AND $3::date AND COALESCE(c.source_module,'') !~ '_person$')
 SELECT c.id,m.id AS ledger_id,m.ledger_name AS ledger,c.date::text AS date,c.particular,c.cash_type AS mode,c.paid,c.received,
 COALESCE(m.opening_balance,0)+SUM(c.received-c.paid) OVER (PARTITION BY m.id ORDER BY c.date,c.id ROWS UNBOUNDED PRECEDING) AS balance
 FROM posted c JOIN cash_flow_months m ON m.id=c.cash_flow_month_id AND m.site_id=$1 AND m.ledger_type<>'site'
 WHERE $2::date IS NOT NULL AND (c.paid<>0 OR c.received<>0) ORDER BY m.ledger_name,m.id,c.date,c.id`;

const PARTNERS = `SELECT le.id,le.entry_date::text AS date,m.full_name AS partner,le.source_key AS nature,
 le.particular,le.raw_mode AS mode,le.debit AS paid,le.credit AS received,le.bank_account_name AS bank
 FROM ledger_entries le
 LEFT JOIN partner_profit_payments ppp ON le.source_key='partner_profit_payments' AND ppp.id=le.source_id
 LEFT JOIN expenses e ON le.source_key='expenses' AND e.id=le.source_id
 LEFT JOIN firm_transactions ft ON le.source_key='firm_transactions' AND ft.id=le.source_id
 LEFT JOIN farmer_payments fp ON le.source_key='farmer_payments' AND fp.id=le.source_id
 LEFT JOIN plot_commission_payments cp ON le.source_key='plot_commission_payments' AND cp.id=le.source_id
 LEFT JOIN plot_commissions_v2 pc ON pc.id=cp.plot_commission_id
 LEFT JOIN cash_flow_months lm ON lm.id=le.cash_flow_month_id AND lm.ledger_type='person'
 JOIN members m ON m.id=COALESCE(ppp.member_id,e.mapped_member_id,ft.mapped_member_id,fp.mapped_member_id,cp.mapped_member_id,pc.agent_id,lm.linked_member_id) AND m.site_id=$1
 WHERE le.site_id=$1 AND le.entry_date BETWEEN $2::date AND $3::date AND (le.debit<>0 OR le.credit<>0)
 AND (UPPER(m.member_type)='PARTNER' OR 'PARTNER'=ANY(m.member_types) OR ppp.id IS NOT NULL
 OR EXISTS(SELECT 1 FROM site_partner_shares s WHERE s.site_id=$1 AND s.member_id=m.id)
 OR EXISTS(SELECT 1 FROM land_partner_shares s JOIN farmers f ON f.id=s.farmer_id WHERE f.site_id=$1 AND s.member_id=m.id))
 ORDER BY m.full_name,le.entry_date,le.id`;

export const YEAR_END_QUERIES = Object.freeze({ registries: REGISTRIES, remaining_plots: REMAINING,
  payment_kyc: PAYMENT_KYC, farmer_balances: FARMER_BALANCES, land_purchases: LAND,
  bank_accounts: BANKS, firm_balances: FIRMS, firm_ledger: FIRM_LEDGER, inter_firm: INTER_FIRM, loans: LOANS, partner_payments: PARTNERS });

const DOCUMENTS = `SELECT d.id,d.title,d.original_name,d.file_path,d.mime_type,d.file_size,d.category,
 d.doc_date::text AS date,COALESCE(d.plot_id,b.plot_id) AS plot_id,d.entity_type,d.entity_id,d.metadata,(to_jsonb(d)->>'farmer_id')::int AS farmer_id,
 COALESCE(f.name,'') AS farmer
 FROM documents d LEFT JOIN farmers f ON f.id=(to_jsonb(d)->>'farmer_id')::int AND f.site_id=$1
 LEFT JOIN kyc_cases k ON k.id=d.kyc_case_id LEFT JOIN bookings b ON b.id=k.booking_id AND b.site_id=$1
 WHERE d.site_id=$1 AND (COALESCE(d.plot_id,b.plot_id) IS NOT NULL OR d.entity_type IN ('registry','cashflow','balance_sheet_requirement') OR f.id IS NOT NULL)
 AND COALESCE(d.uploaded_source,'BOOKING')<>'DMS' ORDER BY d.id`;
const BILLS = `SELECT e.id,e.date::text AS date,e.to_entity AS party,e.category,e.bill_url,e.bill_urls
 FROM expenses e WHERE e.site_id=$1 AND e.date BETWEEN $2::date AND $3::date
 AND (NULLIF(e.bill_url,'') IS NOT NULL OR cardinality(e.bill_urls)>0) ORDER BY e.date,e.id`;

export async function getYearEndReport(scope, allowed, database = pool) {
  const db = await database.connect();
  try {
    await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await db.query("SET LOCAL statement_timeout = '30s'");
    const site = (await db.query('SELECT id,name,code FROM sites WHERE id=$1', [scope.siteId])).rows[0];
    if (!site) throw Object.assign(new Error('Site not found.'), { statusCode: 404 });
    const params = [scope.siteId,scope.from,scope.to];
    const reports = {};
    for (const [key, sql] of Object.entries(YEAR_END_QUERIES)) {
      if (!allowed.has(key)) { reports[key] = { restricted: true, rows: [] }; continue; }
      // One bounded report at a time. Never quietly export a partial schedule.
      const result = await db.query(`${sql} LIMIT 20001`, key === 'loans' ? [...params,scope.loanIds] : params);
      reports[key] = result.rows.length > 20000
        ? { rows: [], error: 'This schedule exceeds 20,000 rows. Use the source module to export it in smaller periods.' }
        : { rows: result.rows };
    }
    const loanAccounts = allowed.has('loans') ? (await db.query(LOAN_ACCOUNTS,params)).rows : [];
    if (allowed.has('loans') && scope.loanIds.some(id => !loanAccounts.some(account => account.id===id))) invalid('A selected loan ledger does not belong to this site.');
    if (allowed.has('loans') && !reports.loans.error) {
      reports.loans.rows=loanAccounts.filter(account => scope.loanIds.includes(account.id)).flatMap(account => [
        {id:`opening-${account.id}`,ledger_id:account.id,ledger:account.name,date:'Opening',particular:'Recorded account opening balance',paid:0,received:0,balance:account.opening_balance},
        ...reports.loans.rows.filter(row => row.ledger_id===account.id),
      ]);
    }
    const documents = (await db.query(DOCUMENTS,[scope.siteId])).rows;
    const bills = allowed.has('purchase_bills') ? (await db.query(BILLS,params)).rows : [];
    const checklistAvailable = (await db.query("SELECT to_regclass('public.balance_sheet_requirements') IS NOT NULL AS ready")).rows[0].ready;
    const checklist = checklistAvailable ? (await db.query(`SELECT requirement,status,notes,updated_at FROM balance_sheet_requirements
      WHERE site_id=$1 AND financial_year=$2 ORDER BY requirement`,[scope.siteId,scope.year])).rows : [];
    await db.query('COMMIT');
    return { site,period:{ financial_year:scope.year,date_from:scope.from,date_to:scope.to },reports,loanAccounts,documents,bills,checklist:checklist.filter(row => allowed.has(row.requirement)),checklistAvailable };
  } catch (error) { await db.query('ROLLBACK'); throw error; } finally { db.release(); }
}
