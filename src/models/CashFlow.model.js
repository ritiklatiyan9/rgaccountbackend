import MasterModel from './MasterModel.js';

// ── Cash Flow Month Model ──
class CashFlowMonthModel extends MasterModel {
  constructor() {
    super('cash_flow_months');
  }

  /** All months for a site, ordered newest first */
  async findBySiteId(siteId, pool) {
    const query = `
      SELECT cfm.*,
        COALESCE((SELECT SUM(cfe.debit) FROM cash_flow_entries cfe WHERE cfe.cash_flow_month_id = cfm.id AND (cfe.cheque_status IS NULL OR cfe.cheque_status NOT IN ('BOUNCED', 'RETURNED'))), 0) AS total_debit,
        COALESCE((SELECT SUM(cfe.credit) FROM cash_flow_entries cfe WHERE cfe.cash_flow_month_id = cfm.id AND (cfe.cheque_status IS NULL OR cfe.cheque_status NOT IN ('BOUNCED', 'RETURNED'))), 0) AS total_credit,
        COALESCE((SELECT SUM(cfe.debit) FROM cash_flow_entries cfe WHERE cfe.cash_flow_month_id = cfm.id AND cfe.cash_type = 'cash' AND (cfe.cheque_status IS NULL OR cfe.cheque_status NOT IN ('BOUNCED', 'RETURNED'))), 0) AS cash_given,
        COALESCE((SELECT SUM(cfe.credit) FROM cash_flow_entries cfe WHERE cfe.cash_flow_month_id = cfm.id AND cfe.cash_type = 'cash' AND (cfe.cheque_status IS NULL OR cfe.cheque_status NOT IN ('BOUNCED', 'RETURNED'))), 0) AS cash_received,
        COALESCE((SELECT SUM(cfe.debit) FROM cash_flow_entries cfe WHERE cfe.cash_flow_month_id = cfm.id AND cfe.cash_type = 'bank' AND (cfe.cheque_status IS NULL OR cfe.cheque_status NOT IN ('BOUNCED', 'RETURNED'))), 0) AS bank_given,
        COALESCE((SELECT SUM(cfe.credit) FROM cash_flow_entries cfe WHERE cfe.cash_flow_month_id = cfm.id AND cfe.cash_type = 'bank' AND (cfe.cheque_status IS NULL OR cfe.cheque_status NOT IN ('BOUNCED', 'RETURNED'))), 0) AS bank_received,
        (SELECT COUNT(*)::int FROM cash_flow_entries cfe WHERE cfe.cash_flow_month_id = cfm.id) AS entry_count
      FROM cash_flow_months cfm
      WHERE cfm.site_id = $1
      ORDER BY cfm.year DESC, cfm.month DESC, cfm.ledger_name ASC
    `;
    const result = await pool.query(query, [siteId]);
    return result.rows;
  }

  /** Find a specific month record by period + ledger name */
  async findByPeriod(siteId, month, year, ledgerName, pool) {
    const query = `SELECT * FROM cash_flow_months WHERE site_id = $1 AND month = $2 AND year = $3 AND ledger_name = $4`;
    const result = await pool.query(query, [siteId, month, year, ledgerName]);
    return result.rows[0];
  }

  /** Get a single month with totals */
  async findByIdWithTotals(id, pool) {
    const query = `
      SELECT cfm.*,
        COALESCE((SELECT SUM(cfe.debit)  FROM cash_flow_entries cfe WHERE cfe.cash_flow_month_id = cfm.id AND (cfe.cheque_status IS NULL OR cfe.cheque_status NOT IN ('BOUNCED', 'RETURNED'))), 0) AS total_debit,
        COALESCE((SELECT SUM(cfe.credit) FROM cash_flow_entries cfe WHERE cfe.cash_flow_month_id = cfm.id AND (cfe.cheque_status IS NULL OR cfe.cheque_status NOT IN ('BOUNCED', 'RETURNED'))), 0) AS total_credit,
        (SELECT COUNT(*)::int FROM cash_flow_entries cfe WHERE cfe.cash_flow_month_id = cfm.id) AS entry_count
      FROM cash_flow_months cfm
      WHERE cfm.id = $1
    `;
    const result = await pool.query(query, [id]);
    return result.rows[0];
  }

  /** Get closing balance for a month (to carry forward as next month's opening) */
  async getClosingBalance(id, pool) {
    const query = `
      SELECT
        cfm.opening_balance,
        COALESCE(SUM(cfe.credit), 0) AS total_credit,
        COALESCE(SUM(cfe.debit), 0) AS total_debit,
        cfm.opening_balance + COALESCE(SUM(cfe.credit), 0) - COALESCE(SUM(cfe.debit), 0) AS closing_balance
      FROM cash_flow_months cfm
      LEFT JOIN cash_flow_entries cfe ON cfe.cash_flow_month_id = cfm.id AND (cfe.cheque_status IS NULL OR cfe.cheque_status NOT IN ('BOUNCED', 'RETURNED'))
      WHERE cfm.id = $1
      GROUP BY cfm.id
    `;
    const result = await pool.query(query, [id]);
    return result.rows[0];
  }

  /** Get the previous month record for carry-forward */
  async getPreviousMonth(siteId, month, year, ledgerName, pool) {
    const prevMonth = month === 1 ? 12 : month - 1;
    const prevYear = month === 1 ? year - 1 : year;
    return this.findByPeriod(siteId, prevMonth, prevYear, ledgerName, pool);
  }

  /** Get unique ledger names for a site (for autocomplete) */
  async getUniqueLedgerNames(siteId, pool) {
    const query = `
      SELECT DISTINCT ledger_name, ledger_type
      FROM cash_flow_months
      WHERE site_id = $1 AND ledger_name IS NOT NULL
      ORDER BY ledger_name ASC
    `;
    const result = await pool.query(query, [siteId]);
    return result.rows;
  }
}

// ── Cash Flow Entry Model ──
class CashFlowEntryModel extends MasterModel {
  constructor() {
    super('cash_flow_entries');
  }

  /** All entries for a month, ordered by date ASC */
  async findByMonthId(monthId, pool) {
    const query = `
      SELECT cfe.*, ff.name AS from_firm_name, tf.name AS to_firm_name, u.name AS created_by_name
      FROM cash_flow_entries cfe
      LEFT JOIN firms ff ON ff.id = cfe.from_firm_id
      LEFT JOIN firms tf ON tf.id = cfe.to_firm_id
      LEFT JOIN users u ON u.id = cfe.created_by
      WHERE cfe.cash_flow_month_id = $1
      ORDER BY date ASC, created_at ASC
    `;
    const result = await pool.query(query, [monthId]);
    return result.rows;
  }

  /** Summary for a month */
  async getMonthSummary(monthId, pool) {
    const query = `
      SELECT
        COUNT(*)::int AS total_entries,
        COALESCE(SUM(debit), 0)  AS total_debit,
        COALESCE(SUM(credit), 0) AS total_credit
      FROM cash_flow_entries
      WHERE cash_flow_month_id = $1 AND (cheque_status IS NULL OR cheque_status NOT IN ('BOUNCED', 'RETURNED'))
    `;
    const result = await pool.query(query, [monthId]);
    return result.rows[0];
  }

  /** Unique particulars for autocomplete (site-wide) */
  async getUniqueParticulars(siteId, pool) {
    const query = `
      SELECT DISTINCT particular FROM cash_flow_entries
      WHERE site_id = $1
      ORDER BY particular ASC
    `;
    const result = await pool.query(query, [siteId]);
    return result.rows.map((r) => r.particular);
  }

  /** Category-wise breakdown for a month */
  async getCategoryBreakdown(monthId, pool) {
    const query = `
      SELECT
        particular,
        COUNT(*)::int AS entries,
        COALESCE(SUM(debit), 0) AS total_debit,
        COALESCE(SUM(credit), 0) AS total_credit
      FROM cash_flow_entries
      WHERE cash_flow_month_id = $1 AND (cheque_status IS NULL OR cheque_status NOT IN ('BOUNCED', 'RETURNED'))
      GROUP BY particular
      ORDER BY total_debit DESC
    `;
    const result = await pool.query(query, [monthId]);
    return result.rows;
  }

  /** Find all entries for a site on a specific date (for Day Book merge) */
  async findBySiteAndDate(siteId, date, pool) {
    const query = `
      SELECT cfe.*,
             cfm.ledger_name,
             cfm.ledger_type,
             cfm.month AS cf_month,
             cfm.year  AS cf_year,
             u.name as assigned_admin_name
      FROM cash_flow_entries cfe
      JOIN cash_flow_months cfm ON cfm.id = cfe.cash_flow_month_id
      LEFT JOIN users u ON cfe.assigned_admin_id = u.id
      WHERE cfe.site_id = $1 AND cfe.date = $2
        AND cfe.source_module IS NULL
      ORDER BY cfe.created_at ASC
    `;
    const result = await pool.query(query, [siteId, date]);
    return result.rows;
  }
}

export const cashFlowMonthModel = new CashFlowMonthModel();
export const cashFlowEntryModel = new CashFlowEntryModel();
