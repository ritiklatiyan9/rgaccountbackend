import MasterModel from './MasterModel.js';

// ── Installment Model ──
class InstallmentModel extends MasterModel {
  constructor() {
    super('plot_installments');
  }

  /** All installments for a plot, sorted by due_date */
  async findByPlotId(plotId, pool) {
    const query = `
      SELECT * FROM plot_installments
      WHERE plot_id = $1
      ORDER BY sort_order ASC, due_date ASC
    `;
    const result = await pool.query(query, [plotId]);
    return result.rows;
  }

  /**
   * Recompute statuses from current date + paid_amount.
   *
   * Derives every row's status from scratch rather than only ratcheting it
   * forward. The old version was three ratcheting UPDATEs that could never
   * downgrade a row, so once paid_amount could fall — a payment edited down
   * or deleted — the installment stayed 'paid' forever. Precedence is
   * unchanged: paid > overdue > partially_paid > pending.
   */
  async refreshStatuses(plotId, pool) {
    const today = new Date().toISOString().split('T')[0];
    await pool.query(`
      UPDATE plot_installments
      SET status = CASE
        WHEN paid_amount >= amount THEN 'paid'
        WHEN due_date < $2          THEN 'overdue'
        WHEN paid_amount > 0        THEN 'partially_paid'
        ELSE 'pending'
      END
      WHERE plot_id = $1
    `, [plotId, today]);
  }
}

// ── Installment Payment Model ──
class InstallmentPaymentModel extends MasterModel {
  constructor() {
    super('plot_installment_payments');
  }

  /** All payments for an installment */
  async findByInstallmentId(installmentId, pool) {
    const query = `
      SELECT pip.*, u.name AS created_by_name
      FROM plot_installment_payments pip
      LEFT JOIN users u ON u.id = pip.created_by
      WHERE pip.installment_id = $1
      ORDER BY pip.payment_date ASC, pip.created_at ASC
    `;
    const result = await pool.query(query, [installmentId]);
    return result.rows;
  }

  /** All payments for a plot */
  async findByPlotId(plotId, pool) {
    const query = `
      SELECT pip.*, pi.installment_name, pi.due_date, u.name AS created_by_name
      FROM plot_installment_payments pip
      JOIN plot_installments pi ON pi.id = pip.installment_id
      LEFT JOIN users u ON u.id = pip.created_by
      WHERE pip.plot_id = $1
      ORDER BY pip.payment_date ASC, pip.created_at ASC
    `;
    const result = await pool.query(query, [plotId]);
    return result.rows;
  }
}

export const installmentModel = new InstallmentModel();
export const installmentPaymentModel = new InstallmentPaymentModel();
