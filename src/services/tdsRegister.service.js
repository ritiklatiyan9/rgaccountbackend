import pool from '../config/db.js';
import { tdsDueDate } from '../utils/tds.js';

// One complete register projection for the module and its Drive workbook.
// Callers authorize the site before reading; no pagination is applied here.
export async function readTdsRegister(siteId, { from = '1900-01-01', to = '2100-12-31' } = {}, db = pool) {
  const { rows } = await db.query(
    `SELECT t.id, t.member_id, t.deductee_name, t.pan, t.aadhaar, t.section,
       t.deduction_date::text AS deduction_date, t.gross_amount, t.tds_rate, t.tds_amount,
       (t.gross_amount-t.tds_amount) AS net_amount, t.nature, t.deposit_date::text AS deposit_date,
       t.challan_no, t.notes, t.commission_payment_id, t.source_table, t.source_id, t.source_details, COALESCE(t.source_module,'manual') AS source_module,
       COALESCE(t.calculation_mode,'manual') AS calculation_mode,
       t.ca_name, t.ca_sent_at, t.ca_transfer_id, ct.date::text AS ca_transfer_date,
       t.settlement_id, s.kind AS settlement_kind, s.date::text AS settlement_date,
       COALESCE(s.existing_entry_id, settlement_entry.id) AS settlement_entry_id,
       s.payment_mode AS settlement_payment_mode, s.transaction_id AS settlement_reference,
       pc.plot_id, pc.farmer_id, pc.land_deal_id, pc.id AS commission_id,
       COALESCE(t.source_label, 'Plot '||p.plot_no, 'Land purchase #'||pc.farmer_id, 'Land sale #'||pc.land_deal_id, 'Manual entry') AS source_label,
       COALESCE(pay.payment_mode,t.source_details->>'payment_mode') AS payment_mode, COALESCE(pay.transaction_id,t.source_details->>'transaction_id') AS transaction_id, COALESCE(pay.cheque_no,t.source_details->>'cheque_no') AS cheque_no, COALESCE(pay.cheque_status,t.source_details->>'cheque_status') AS cheque_status,
       COALESCE(u.name,'—') AS created_by_name, t.created_at, t.updated_at,
       CASE WHEN t.source_id IS NOT NULL THEN t.payment_state WHEN t.commission_payment_id IS NULL THEN 'active'
         WHEN lower(COALESCE(pay.status,'approved'))='rejected' OR COALESCE(pay.cheque_status,'') IN ('BOUNCED','RETURNED') THEN 'reversed'
         WHEN financial_transaction_posts(CASE WHEN pay.amount<0 THEN 'credit' ELSE 'debit' END,pay.status,pay.payment_mode,pay.cheque_status) THEN 'active'
         ELSE 'pending' END AS payment_state
     FROM tds_deductions t
     LEFT JOIN plot_commission_payments pay ON pay.id=t.commission_payment_id
     LEFT JOIN plot_commissions_v2 pc ON pc.id=pay.plot_commission_id
     LEFT JOIN plots p ON p.id=pc.plot_id
     LEFT JOIN users u ON u.id=t.created_by
     LEFT JOIN tds_settlements ct ON ct.id=t.ca_transfer_id
     LEFT JOIN tds_settlements s ON s.id=t.settlement_id
     LEFT JOIN cash_flow_entries settlement_entry ON settlement_entry.source_module='tds_settlements' AND settlement_entry.source_id=s.id
     WHERE t.site_id=$1 AND t.deduction_date BETWEEN $2::date AND $3::date
     ORDER BY t.deduction_date DESC, t.id DESC`,
    [siteId, from, to],
  );
  return rows.map((row) => ({ ...row, due_date: tdsDueDate(row.deduction_date) }));
}
