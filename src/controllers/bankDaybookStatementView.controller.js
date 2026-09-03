import pool from '../config/db.js';

const numericId = (value, label = 'id') => {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    const error = new Error(`A valid ${label} is required.`);
    error.statusCode = 400;
    throw error;
  }
  return parsed;
};

const isoDate = (value, label) => {
  if (value == null || value === '') return null;
  const text = String(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const error = new Error(`${label} must be YYYY-MM-DD.`);
    error.statusCode = 400;
    throw error;
  }
  return text;
};

const dateOnly = (value) => {
  if (!value) return null;
  // PostgreSQL DATE values arrive as local-midnight Date objects in this
  // deployment. Formatting with UTC would move Indian dates back one day.
  if (value instanceof Date && !Number.isNaN(value.valueOf())) {
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
  }
  return String(value).slice(0, 10);
};

async function assertSiteAccess(user, requestedSiteId) {
  const siteId = numericId(requestedSiteId, 'site id');
  const result = await pool.query(
    `SELECT s.id, s.name, s.organization_id,
            CASE WHEN $3 = 'sub_admin' THEN EXISTS (
              SELECT 1 FROM user_sites us WHERE us.site_id = s.id AND us.user_id = $2
            ) ELSE TRUE END AS assigned
       FROM sites s
      WHERE s.id = $1 AND s.organization_id = $4`,
    [siteId, user.id, user.role, Number(user.organization_id) || 1],
  );
  const site = result.rows[0];
  if (!site || !site.assigned) {
    const error = new Error('The selected site is outside your authorised workspace.');
    error.statusCode = 403;
    throw error;
  }
  return site;
}

const numberValue = (value) => value == null ? null : Number(value);

const rowDto = (row) => ({
  id: Number(row.id),
  position: Number(row.position),
  sheet_row: row.sheet_row == null ? null : Number(row.sheet_row),
  statement_serial: row.statement_serial || '',
  transaction_date: dateOnly(row.transaction_date),
  value_date: dateOnly(row.value_date),
  narration: row.narration || '',
  transaction_reference: row.transaction_reference || '',
  cheque_reference: row.cheque_reference || '',
  debit: numberValue(row.debit) || 0,
  credit: numberValue(row.credit) || 0,
  running_balance: numberValue(row.running_balance),
});

export async function getActiveBankDaybookStatementView(req, res) {
  try {
    const site = await assertSiteAccess(req.user, req.query.site_id ?? req.query.siteId);
    const exactDate = isoDate(req.query.date, 'Date');
    const dateFrom = exactDate || isoDate(req.query.date_from, 'From date');
    const dateTo = exactDate || isoDate(req.query.date_to, 'To date');
    if (dateFrom && dateTo && dateFrom > dateTo) {
      const error = new Error('From date cannot be after To date.');
      error.statusCode = 400;
      throw error;
    }

    const viewResult = await pool.query(
      `SELECT *
         FROM bank_daybook_statement_views
        WHERE site_id = $1
          AND organization_id = $2
          AND is_active
        LIMIT 1`,
      [site.id, site.organization_id],
    );
    const view = viewResult.rows[0];
    if (!view) return res.json({ active: false, rows: [] });

    const rowsResult = await pool.query(
      `SELECT *
         FROM bank_daybook_statement_view_rows
        WHERE view_id = $1
          AND ($2::date IS NULL OR transaction_date >= $2::date)
          AND ($3::date IS NULL OR transaction_date <= $3::date)
        ORDER BY position ASC`,
      [view.id, dateFrom, dateTo],
    );
    const rows = rowsResult.rows.map(rowDto);
    const first = rows[0] || null;
    const last = rows.at(-1) || null;
    let openingBalance = 0;
    if (first) {
      const previous = await pool.query(
        `SELECT running_balance
           FROM bank_daybook_statement_view_rows
          WHERE view_id = $1 AND position < $2
          ORDER BY position DESC
          LIMIT 1`,
        [view.id, first.position],
      );
      openingBalance = previous.rows[0]?.running_balance != null
        ? Number(previous.rows[0].running_balance)
        : Number(first.running_balance || 0) - first.credit + first.debit;
    } else if (dateTo || dateFrom) {
      // A quiet day still has a bank balance. Carry the last printed balance
      // forward instead of showing zero when the chosen date is later than
      // the latest line in the supplied statement.
      const carryForward = await pool.query(
        `SELECT running_balance
           FROM bank_daybook_statement_view_rows
          WHERE view_id = $1
            AND transaction_date <= $2::date
          ORDER BY position DESC
          LIMIT 1`,
        [view.id, dateTo || dateFrom],
      );
      openingBalance = carryForward.rows[0]?.running_balance != null
        ? Number(carryForward.rows[0].running_balance)
        : 0;
    }
    const sumMoney = (field) => Math.round(rows.reduce((sum, row) => sum + (Number(row[field]) || 0), 0) * 100) / 100;
    const totalDebit = sumMoney('debit');
    const totalCredit = sumMoney('credit');

    return res.json({
      active: true,
      view: {
        id: Number(view.id),
        source_filename: view.source_filename,
        account_number: view.account_number || '',
        date_from: dateOnly(view.date_from),
        date_to: dateOnly(view.date_to),
        statement_sheet: view.statement_sheet || '',
      },
      rows,
      summary: {
        opening_balance: openingBalance,
        closing_balance: last?.running_balance ?? openingBalance,
        total_debit: totalDebit,
        total_credit: totalCredit,
        total_count: rows.length,
      },
    });
  } catch (error) {
    const status = Number(error.statusCode) || 500;
    if (status >= 500) console.error('[bank-daybook-statement-view]', error);
    return res.status(status).json({
      message: status >= 500 ? 'Bank statement view could not be loaded.' : error.message,
    });
  }
}
