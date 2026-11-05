import { loadUnrecordedPoolCollections } from './poolMoneyCheques.service.js';

export async function bookingMoneyPredicate(db) {
  const { rows: [schema] } = await db.query(`SELECT
    to_regclass('public.pool_money_receipts') IS NOT NULL AS pool,
    to_regclass('public.bookings') IS NOT NULL AS bookings,
    to_regclass('public.draw_payments') IS NOT NULL AS draws`);
  const links = [];
  if (schema.pool) links.push('EXISTS(SELECT 1 FROM pool_money_receipts origin WHERE origin.plot_payment_id=le.source_id)');
  if (schema.bookings) links.push("EXISTS(SELECT 1 FROM bookings origin WHERE NULLIF(to_jsonb(origin)->>'token_payment_id','')::integer=le.source_id)");
  if (schema.draws) links.push("EXISTS(SELECT 1 FROM draw_payments origin WHERE NULLIF(to_jsonb(origin)->>'plot_payment_id','')::integer=le.source_id)");
  return `(le.source_key='pool_money_receipts'${links.length ? ` OR (le.source_key='plot_payments' AND (${links.join(' OR ')}))` : ''})`;
}

const BANK_MODES = ['BANK', 'TRANSFER', 'UPI', 'NEFT', 'RTGS', 'IMPS', 'CHEQUE'];
const nameKey = value => String(value || '').trim().toUpperCase().replace(/\s+/g, ' ');

export async function bankBookingPending(db, organizationId, siteId, bank) {
  const sources = await loadUnrecordedPoolCollections(db, organizationId, siteId, { modes: BANK_MODES, status: null });
  const { rows: banks } = await db.query('SELECT id,name FROM bank_accounts WHERE site_id=$1', [siteId]);
  const matchesBank = receipt => {
    if (receipt.bank_account_id != null) return Number(receipt.bank_account_id) === Number(bank.id);
    const matches = banks.filter(candidate => nameKey(candidate.name) === nameKey(receipt.bank_name));
    return nameKey(receipt.bank_name) && matches.length === 1 && Number(matches[0].id) === Number(bank.id);
  };
  const pending = sources.filter(matchesBank).map(receipt => ({ ...receipt, posting_state: 'AWAITING_ACCOUNTS' }));
  const { rows: [schema] } = await db.query("SELECT to_regclass('public.pool_money_receipts') IS NOT NULL AS ready");
  if (schema.ready) {
    const { rows } = await db.query(`SELECT r.id,r.source_kind AS kind,r.owner_id,r.source_id,r.reference,r.reference AS receipt_no,
      r.buyer_name AS customer_name,to_char(r.date,'YYYY-MM-DD') AS date,r.amount,r.payment_from,r.bank_name,r.cheque_no,
      COALESCE(c.bank_account_id,r.bank_account_id) AS bank_account_id,
      COALESCE(c.status,r.status) AS status,COALESCE(c.cheque_status,r.cheque_status) AS cheque_status,
      CASE WHEN r.payment_type='CHEQUE' THEN 'AWAITING_CHEQUE_CLEARANCE' ELSE 'AWAITING_BANK_POSTING' END AS posting_state
      FROM pool_money_receipts r JOIN sites s ON s.id=r.site_id AND s.organization_id=$3
      LEFT JOIN cash_flow_entries c ON
        (r.plot_payment_id IS NULL AND c.source_module='pool_money_receipts' AND c.source_id=r.id) OR
        (r.plot_payment_id IS NOT NULL AND c.source_module='plot_payments' AND c.source_id=r.plot_payment_id)
      WHERE r.site_id=$1 AND r.payment_type IN ('BANK','CHEQUE') AND NOT EXISTS(
        SELECT 1 FROM ledger_entries le WHERE le.site_id=r.site_id AND le.bank_account_id=$2
          AND ((r.plot_payment_id IS NULL AND le.source_key='pool_money_receipts' AND le.source_id=r.id)
            OR (r.plot_payment_id IS NOT NULL AND le.source_key='plot_payments' AND le.source_id=r.plot_payment_id))
          AND (le.credit<>0 OR le.debit<>0))`, [siteId, bank.id, organizationId]);
    pending.push(...rows.filter(matchesBank).map(receipt => ({ ...receipt, id: `recorded:${receipt.id}`, recorded: true })));
  }
  return pending.sort((a, b) => String(b.date).localeCompare(String(a.date)) || String(b.id).localeCompare(String(a.id)));
}
