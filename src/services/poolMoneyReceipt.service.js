import { chequeReadyForApproval } from '../utils/chequeWorkflow.js';

const fail = (statusCode, message, code) => { throw Object.assign(new Error(message), { statusCode, code }); };
const validId = value => /^\d+$/.test(String(value)) && Number.isSafeInteger(Number(value)) && Number(value) > 0 && Number(value) <= 2147483647;

export async function approvePoolMoneyReceipt(database, user, { receiptId, siteId, expectedAmount } = {}) {
  if (!['admin', 'super_admin'].includes(user?.role)) fail(403, 'Only an administrator can approve collected pool money.', 'POOL_APPROVAL_FORBIDDEN');
  if (!validId(receiptId) || !validId(siteId)) fail(400, 'A valid receipt and project are required.', 'POOL_RECEIPT_INVALID');
  const expected = Number(expectedAmount);
  if (expectedAmount == null || !Number.isFinite(expected) || expected <= 0) fail(400, 'Review the receipt amount before approval.', 'POOL_RECEIPT_AMOUNT_REQUIRED');
  const db = await database.connect();
  try {
    await db.query('BEGIN');
    const { rows: [receipt] } = await db.query(`SELECT r.* FROM pool_money_receipts r
      JOIN sites s ON s.id=r.site_id AND s.organization_id=$3
      WHERE r.id=$1 AND r.site_id=$2 FOR UPDATE OF r`, [Number(receiptId), Number(siteId), user.organization_id]);
    if (!receipt) fail(404, 'Pool receipt not found in this project.', 'POOL_RECEIPT_NOT_FOUND');
    if (receipt.plot_payment_id) fail(409, 'This receipt has been allotted. Approve its plot payment instead.', 'POOL_RECEIPT_ALLOTTED');
    const { rows: [ledger] } = await db.query(`SELECT c.*,m.is_locked FROM cash_flow_entries c
      LEFT JOIN cash_flow_months m ON m.id=c.cash_flow_month_id
      WHERE c.source_module='pool_money_receipts' AND c.source_id=$1 AND c.site_id=$2 FOR UPDATE OF c`, [receipt.id, receipt.site_id]);
    if (!ledger) fail(409, 'The pool receipt accounting entry is missing.', 'POOL_RECEIPT_LEDGER_MISSING');
    if (ledger.is_locked) fail(409, 'The receipt belongs to a locked accounting period.', 'ACCOUNTING_PERIOD_LOCKED');
    if (Math.round(Number(receipt.amount) * 100) !== Math.round(expected * 100)
      || Math.round(Number(ledger.credit) * 100) !== Math.round(expected * 100) || Number(ledger.debit) !== 0) {
      fail(409, 'The receipt amount changed. Refresh and review it before approving.', 'POOL_RECEIPT_AMOUNT_CHANGED');
    }
    if (receipt.status !== 'pending' || ledger.status !== 'pending') fail(409, 'This receipt has already been decided. Refresh the collection.', 'POOL_RECEIPT_ALREADY_DECIDED');
    if (!chequeReadyForApproval(receipt) || !chequeReadyForApproval(ledger)) {
      fail(409, 'Clear the cheque in Pending Cheque Matching before approving it.', 'CHEQUE_CLEARANCE_REQUIRED');
    }
    const { rows: [updated] } = await db.query(`UPDATE pool_money_receipts SET status='approved',approved_by=$2,
      approved_at=now(),updated_at=now() WHERE id=$1 RETURNING *`, [receipt.id, user.id]);
    await db.query(`INSERT INTO pool_money_events(source_kind,owner_id,site_id,event_type,detail,actor_user_id)
      VALUES($1,$2,$3,'RECEIPT_APPROVED',$4,$5)`, [receipt.source_kind, receipt.owner_id, receipt.site_id,
      { receipt_id: receipt.id, reference: receipt.reference, amount: Number(receipt.amount), cheque_status: receipt.cheque_status }, user.id]);
    await db.query('COMMIT');
    return { receipt: updated, message: 'Pool receipt approved.' };
  } catch (error) { await db.query('ROLLBACK'); throw error; }
  finally { db.release(); }
}
