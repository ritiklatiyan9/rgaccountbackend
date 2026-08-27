const SOURCE_CONFIG = Object.freeze({
  farmer_payment: { table: 'farmer_payments', mirror: 'farmer_payments' },
  plot_commission_payment: { table: 'plot_commission_payments', mirror: 'plot_commission_payments' },
  firm_transaction: { table: 'firm_transactions', mirror: 'firm_transactions' },
  plot_payment: { table: 'plot_payments', mirror: 'plot_payments' },
  plot_installment_payment: { table: 'plot_installment_payments', mirror: 'plot_installment_payments' },
  expense: { table: 'expenses', mirror: 'expenses' },
  vendor_payment: { table: 'vendor_payments', mirror: 'vendor_payments' },
  vendor_inventory_payment: { table: 'vendor_inventory_payments', mirror: 'vendor_inventory_payments' },
  plot_registry_payment: { table: 'plot_registry_payments', mirror: 'plot_registry_payments' },
  daybook: { table: 'day_book', mirror: 'day_book' },
  cash_flow_entry: { table: 'cash_flow_entries', mirror: null },
});

export const CHEQUE_STATUSES = Object.freeze(['PENDING', 'CLEARED', 'BOUNCED', 'RETURNED']);
export const CHEQUE_SOURCE_CONFIG = SOURCE_CONFIG;

export class ChequeStatusError extends Error {
  constructor(message, statusCode = 409, code = 'CHEQUE_STATUS_CONFLICT') {
    super(message);
    this.name = 'ChequeStatusError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

const normalizedStatus = (status) => String(status || '').trim().toUpperCase();

async function lockMirror(db, source, entryId) {
  const config = SOURCE_CONFIG[source];
  if (source === 'cash_flow_entry') {
    const result = await db.query(
      `SELECT * FROM cash_flow_entries
        WHERE id = $1 AND source_module IS NULL
        FOR UPDATE`,
      [entryId]
    );
    return result.rows[0] || null;
  }
  const result = await db.query(
    `SELECT * FROM cash_flow_entries
      WHERE source_module = $1 AND source_id = $2
      ORDER BY id
      LIMIT 1
      FOR UPDATE`,
    [config.mirror, entryId]
  );
  return result.rows[0] || null;
}

async function reconcilePlotCommission(db, paymentId) {
  const result = await db.query(
    `SELECT plot_commission_id FROM plot_commission_payments WHERE id = $1`,
    [paymentId]
  );
  const commissionId = result.rows[0]?.plot_commission_id;
  if (!commissionId) return;
  await db.query(
    `UPDATE plot_commissions_v2 pc
        SET status = CASE
          WHEN paid.total >= pc.total_commission THEN 'Completed'
          WHEN paid.total > 0 THEN 'Partial'
          ELSE 'Pending'
        END,
        updated_at = NOW()
       FROM (
         SELECT COALESCE(SUM(amount), 0)::numeric AS total
           FROM plot_commission_payments
          WHERE plot_commission_id = $1
            AND status = 'approved'
            AND (cheque_status IS NULL OR cheque_status NOT IN ('BOUNCED', 'RETURNED'))
       ) paid
      WHERE pc.id = $1`,
    [commissionId]
  );
}

async function reconcileInstallment(db, paymentId) {
  const result = await db.query(
    `SELECT installment_id FROM plot_installment_payments WHERE id = $1`,
    [paymentId]
  );
  const installmentId = result.rows[0]?.installment_id;
  if (!installmentId) return;
  await db.query(
    `UPDATE plot_installments pi
        SET paid_amount = paid.total,
            status = CASE
              WHEN paid.total >= pi.amount THEN 'paid'
              WHEN pi.due_date < CURRENT_DATE THEN 'overdue'
              WHEN paid.total > 0 THEN 'partially_paid'
              ELSE 'pending'
            END,
            updated_at = NOW()
       FROM (
         SELECT COALESCE(SUM(amount), 0)::numeric AS total
           FROM plot_installment_payments
          WHERE installment_id = $1
            AND LOWER(COALESCE(status, 'approved')) = 'approved'
            AND (cheque_status IS NULL OR cheque_status NOT IN ('BOUNCED', 'RETURNED'))
       ) paid
      WHERE pi.id = $1`,
    [installmentId]
  );
}

/**
 * The shared accounting command used by both the existing cheque control and
 * bank reconciliation. Callers own the transaction boundary.
 */
export async function updateChequeStatusRecord(db, {
  source,
  entryId,
  status,
  chequeNo,
  expectedSiteId,
  expectedAmount,
  requirePending = false,
}) {
  const config = SOURCE_CONFIG[source];
  const targetStatus = normalizedStatus(status);
  const numericEntryId = Number.parseInt(entryId, 10);
  if (!config) throw new ChequeStatusError(`Invalid cheque source: ${source}`, 400, 'INVALID_SOURCE');
  if (!Number.isInteger(numericEntryId) || numericEntryId <= 0) throw new ChequeStatusError('Invalid cheque entry id', 400, 'INVALID_ENTRY_ID');
  if (!CHEQUE_STATUSES.includes(targetStatus)) throw new ChequeStatusError(`Invalid cheque status: ${targetStatus}`, 400, 'INVALID_STATUS');

  const mirror = await lockMirror(db, source, numericEntryId);
  if (!mirror) throw new ChequeStatusError('The cheque entry is missing from the accounting ledger.', 409, 'MISSING_LEDGER_MIRROR');
  if (expectedSiteId != null && Number(mirror.site_id) !== Number(expectedSiteId)) {
    throw new ChequeStatusError('The cheque does not belong to the selected site.', 403, 'SITE_SCOPE_MISMATCH');
  }
  if (expectedAmount != null) {
    const actual = Math.max(Number(mirror.debit || 0), Number(mirror.credit || 0)).toFixed(2);
    if (actual !== Number(expectedAmount).toFixed(2)) {
      throw new ChequeStatusError('The cheque amount changed after matching. Refresh and run matching again.', 409, 'STALE_AMOUNT');
    }
  }
  if (requirePending && mirror.cash_flow_month_id) {
    const period = await db.query(
      `SELECT is_locked FROM cash_flow_months WHERE id = $1`,
      [mirror.cash_flow_month_id]
    );
    if (period.rows[0]?.is_locked) {
      throw new ChequeStatusError('The cheque belongs to a locked accounting period. Unlock or use the approved adjustment workflow.', 409, 'ACCOUNTING_PERIOD_LOCKED');
    }
  }

  let sourceBefore = mirror;
  let sourceAfter;
  const trimmedChequeNo = chequeNo === undefined ? undefined : (chequeNo ? String(chequeNo).trim() : null);
  if (source === 'cash_flow_entry') {
    if (requirePending && normalizedStatus(mirror.cheque_status) !== 'PENDING') {
      throw new ChequeStatusError('This cheque is no longer pending.', 409, 'STALE_STATUS');
    }
    const setParts = ['cheque_status = $1', 'updated_at = NOW()'];
    const params = [targetStatus];
    if (trimmedChequeNo !== undefined) {
      params.push(trimmedChequeNo);
      setParts.push(`cheque_no = $${params.length}`);
    }
    params.push(numericEntryId);
    const updated = await db.query(
      `UPDATE cash_flow_entries SET ${setParts.join(', ')} WHERE id = $${params.length} RETURNING *`,
      params
    );
    sourceAfter = updated.rows[0];
  } else {
    const locked = await db.query(`SELECT * FROM ${config.table} WHERE id = $1 FOR UPDATE`, [numericEntryId]);
    sourceBefore = locked.rows[0];
    if (!sourceBefore) throw new ChequeStatusError('Cheque entry not found.', 404, 'ENTRY_NOT_FOUND');
    if (requirePending && normalizedStatus(sourceBefore.cheque_status) !== 'PENDING') {
      throw new ChequeStatusError('This cheque is no longer pending.', 409, 'STALE_STATUS');
    }
    const setParts = ['cheque_status = $1', 'updated_at = NOW()'];
    const params = [targetStatus];
    if (trimmedChequeNo !== undefined) {
      params.push(trimmedChequeNo);
      setParts.push(`cheque_no = $${params.length}`);
    }
    params.push(numericEntryId);
    const updated = await db.query(
      `UPDATE ${config.table} SET ${setParts.join(', ')} WHERE id = $${params.length} RETURNING *`,
      params
    );
    sourceAfter = updated.rows[0];

    const mirrorParts = ['cheque_status = $1', 'updated_at = NOW()'];
    const mirrorParams = [targetStatus];
    if (trimmedChequeNo !== undefined) {
      mirrorParams.push(trimmedChequeNo);
      mirrorParts.push(`cheque_no = $${mirrorParams.length}`);
    }
    mirrorParams.push(config.mirror, numericEntryId);
    await db.query(
      `UPDATE cash_flow_entries
          SET ${mirrorParts.join(', ')}
        WHERE source_module = $${mirrorParams.length - 1} AND source_id = $${mirrorParams.length}`,
      mirrorParams
    );
  }

  if (source === 'vendor_payment') {
    await db.query(
      `UPDATE vendor_inventory_payments
          SET cheque_status = $2,
              cheque_no = CASE WHEN $3::text IS NULL THEN cheque_no ELSE $3 END,
              updated_at = NOW()
        WHERE source_vendor_payment_id = $1`,
      [numericEntryId, targetStatus, trimmedChequeNo === undefined ? null : trimmedChequeNo]
    );
  }
  if (source === 'plot_commission_payment') await reconcilePlotCommission(db, numericEntryId);
  if (source === 'plot_installment_payment') await reconcileInstallment(db, numericEntryId);

  return { before: sourceBefore, after: sourceAfter, mirror };
}
