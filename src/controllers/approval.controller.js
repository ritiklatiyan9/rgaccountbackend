import asyncHandler from '../utils/asyncHandler.js';
import pool from '../config/db.js';

/**
 * Unified approval controller for all financial modules.
 * Handles approving/rejecting entries across:
 *   farmer_payments, plot_commissions, cash_flow_entries,
 *   firm_transactions, plot_payments, expenses, day_book
 */

const ALLOWED_TABLES = {
  farmer_payment: 'farmer_payments',
  plot_commission: 'plot_commissions', // Legacy
  plot_commission_payment: 'plot_commission_payments', // New v2
  cash_flow_entry: 'cash_flow_entries',
  firm_transaction: 'firm_transactions',
  plot_payment: 'plot_payments',
  expense: 'expenses',
  daybook: 'day_book',
};

function getTableName(source) {
  const table = ALLOWED_TABLES[source];
  if (!table) throw new Error(`Invalid source: ${source}`);
  return table;
}

/**
 * GET /approvals/pending
 * List all pending entries across all modules (admin only)
 */
export const listAllPending = asyncHandler(async (req, res) => {
  const { site_id, date_from, date_to, module } = req.query;

  const results = [];

  // Helper to build WHERE clause
  const buildWhere = (tableAlias, siteAlias, extraConditions = []) => {
    const sAlias = siteAlias || tableAlias;
    const conditions = [`${tableAlias}.status = 'pending'`, ...extraConditions];
    const params = [];
    let idx = 1;
    if (site_id) {
      conditions.push(`${sAlias}.site_id = $${idx++}`);
      params.push(parseInt(site_id));
    }
    if (date_from) {
      conditions.push(`${tableAlias}.date >= $${idx++}`);
      params.push(date_from);
    }
    if (date_to) {
      conditions.push(`${tableAlias}.date <= $${idx++}`);
      params.push(date_to);
    }
    return { where: conditions.join(' AND '), params };
  };

  // 1. Farmer Payments (from farmer_payments table)
  if (!module || module === 'farmer_payment') {
    const { where, params } = buildWhere('fp', 'f');
    const q = `
      SELECT fp.*, f.name AS farmer_name, f.site_id,
             s.name AS site_name, u.name AS created_by_name,
             'farmer_payment' AS source
      FROM farmer_payments fp
      JOIN farmers f ON fp.farmer_id = f.id
      JOIN sites s ON f.site_id = s.id
      LEFT JOIN users u ON fp.approved_by = u.id
      WHERE ${where}
      ORDER BY fp.date DESC, fp.id DESC
    `;
    const r = await pool.query(q, params);
    results.push(...r.rows.map(row => ({
      ...row,
      entry_label: `${row.farmer_name} - ₹${row.amount}`,
      module_label: 'Farmer Payment',
    })));
  }

  // 2. Plot Commissions (Legacy)
  if (!module || module === 'plot_commission') {
    const { where, params } = buildWhere('pc', 'pc');
    const q = `
      SELECT pc.*, s.name AS site_name, u.name AS created_by_name,
             'plot_commission' AS source
      FROM plot_commissions pc
      JOIN sites s ON pc.site_id = s.id
      LEFT JOIN users u ON pc.created_by = u.id
      WHERE ${where}
      ORDER BY pc.date DESC, pc.id DESC
    `;
    const r = await pool.query(q, params);
    results.push(...r.rows.map(row => ({
      ...row,
      entry_label: `${row.particular} - ₹${row.amount}`,
      module_label: 'Plot Commission (Legacy)',
    })));
  }

  // 2.5 Plot Commission Payments (V2)
  if (!module || module === 'plot_commission_payment') {
    const { where, params } = buildWhere('pcp', 'pcp');
    const q = `
      SELECT pcp.*, s.name AS site_name, u.name AS created_by_name,
             p.plot_no, p.buyer_name, ag.full_name AS agent_name,
             'plot_commission_payment' AS source
      FROM plot_commission_payments pcp
      JOIN sites s ON pcp.site_id = s.id
      JOIN plot_commissions_v2 pcm ON pcp.plot_commission_id = pcm.id
      JOIN plots p ON pcm.plot_id = p.id
      JOIN members ag ON pcm.agent_id = ag.id
      LEFT JOIN users u ON pcp.created_by = u.id
      WHERE ${where}
      ORDER BY pcp.date DESC, pcp.id DESC
    `;
    const r = await pool.query(q, params);
    results.push(...r.rows.map(row => ({
      ...row,
      entry_label: `${row.agent_name} (Plot ${row.plot_no}) - ₹${row.amount}`,
      module_label: 'Plot Commission payment',
    })));
  }

  // 3. Cash Flow Entries
  if (!module || module === 'cash_flow_entry') {
    const { where, params } = buildWhere('cfe', 'cfe');
    const q = `
      SELECT cfe.*, cfe.site_id, s.name AS site_name, u.name AS created_by_name,
             cfm.ledger_name, cfm.month, cfm.year,
             'cash_flow_entry' AS source
      FROM cash_flow_entries cfe
      JOIN sites s ON cfe.site_id = s.id
      JOIN cash_flow_months cfm ON cfe.cash_flow_month_id = cfm.id
      LEFT JOIN users u ON cfe.created_by = u.id
      WHERE ${where}
      ORDER BY cfe.date DESC, cfe.id DESC
    `;
    const r = await pool.query(q, params);
    results.push(...r.rows.map(row => ({
      ...row,
      entry_label: `${row.particular} - Dr:₹${row.debit} Cr:₹${row.credit}`,
      module_label: 'Cash Flow',
    })));
  }

  // 4. Firm Transactions
  if (!module || module === 'firm_transaction') {
    const { where, params } = buildWhere('ft', 'ft');
    const q = `
      SELECT ft.*, s.name AS site_name, u.name AS created_by_name,
             fi.name AS firm_name,
             'firm_transaction' AS source
      FROM firm_transactions ft
      JOIN sites s ON ft.site_id = s.id
      JOIN firms fi ON ft.firm_id = fi.id
      LEFT JOIN users u ON ft.created_by = u.id
      WHERE ${where}
      ORDER BY ft.date DESC, ft.id DESC
    `;
    const r = await pool.query(q, params);
    results.push(...r.rows.map(row => ({
      ...row,
      entry_label: `${row.firm_name}: ${row.description} - Dr:₹${row.debit} Cr:₹${row.credit}`,
      module_label: 'Firm Transaction',
    })));
  }

  // 5. Plot Payments
  if (!module || module === 'plot_payment') {
    const { where, params } = buildWhere('pp', 'pp');
    const q = `
      SELECT pp.*, s.name AS site_name, u.name AS created_by_name,
             p.plot_no, p.buyer_name,
             'plot_payment' AS source
      FROM plot_payments pp
      JOIN sites s ON pp.site_id = s.id
      JOIN plots p ON pp.plot_id = p.id
      LEFT JOIN users u ON pp.created_by = u.id
      WHERE ${where}
      ORDER BY pp.date DESC, pp.id DESC
    `;
    const r = await pool.query(q, params);
    results.push(...r.rows.map(row => ({
      ...row,
      entry_label: `Plot ${row.plot_no} (${row.buyer_name || 'N/A'}) - ₹${row.amount}`,
      module_label: 'Plot Payment',
    })));
  }

  // 6. Expenses
  if (!module || module === 'expense') {
    const { where, params } = buildWhere('e', 'e');
    const q = `
      SELECT e.*, s.name AS site_name, u.name AS created_by_name,
             'expense' AS source
      FROM expenses e
      JOIN sites s ON e.site_id = s.id
      LEFT JOIN users u ON e.created_by = u.id
      WHERE ${where}
      ORDER BY e.date DESC, e.id DESC
    `;
    const r = await pool.query(q, params);
    results.push(...r.rows.map(row => ({
      ...row,
      entry_label: `${row.to_entity || row.remark || 'Expense'} - Dr:₹${row.debit} Cr:₹${row.credit}`,
      module_label: 'Expense',
    })));
  }

  // 7. Day Book entries (farmer payments, commissions, expenses auto-created in day_book)
  {
    const DAYBOOK_TYPE_MAP = {
      'FARMER PAYMENT': 'daybook_farmer',
      'PLOT COMMISSION': 'daybook_commission',
      'EXPENSE': 'daybook_expense',
    };
    const DAYBOOK_LABEL_MAP = {
      'FARMER PAYMENT': 'Farmer Payment (DayBook)',
      'PLOT COMMISSION': 'Plot Commission (DayBook)',
      'EXPENSE': 'Expense (DayBook)',
    };

    // Map module filter to entry_type
    let entryTypeFilter = `d.entry_type IN ('FARMER PAYMENT', 'PLOT COMMISSION', 'EXPENSE')`;
    if (module === 'farmer_payment') entryTypeFilter = `d.entry_type = 'FARMER PAYMENT'`;
    else if (module === 'plot_commission') entryTypeFilter = `d.entry_type = 'PLOT COMMISSION'`;
    else if (module === 'expense') entryTypeFilter = `d.entry_type = 'EXPENSE'`;
    else if (module && !['farmer_payment', 'plot_commission', 'expense'].includes(module)) entryTypeFilter = null;

    if (entryTypeFilter) {
      const { where, params } = buildWhere('d', 'd');
      const q = `
        SELECT d.*, s.name AS site_name, u.name AS created_by_name,
               'daybook' AS source
        FROM day_book d
        JOIN sites s ON d.site_id = s.id
        LEFT JOIN users u ON d.created_by = u.id
        WHERE ${where} AND ${entryTypeFilter}
        ORDER BY d.date DESC, d.id DESC
      `;
      const r = await pool.query(q, params);
      results.push(...r.rows.map(row => {
        const src = DAYBOOK_TYPE_MAP[row.entry_type] || 'daybook';
        return {
          ...row,
          source: src,
          entry_label: `${row.to_entity || row.particular || 'Entry'} - Dr:₹${row.debit || 0} Cr:₹${row.credit || 0}`,
          module_label: DAYBOOK_LABEL_MAP[row.entry_type] || 'Day Book',
        };
      }));
    }
  }

  // Sort combined results by date DESC
  results.sort((a, b) => {
    const dA = new Date(a.date), dB = new Date(b.date);
    return dB - dA || b.id - a.id;
  });

  res.json({ entries: results, total: results.length });
});

/**
 * GET /approvals/counts
 * Get pending counts per module (admin only)
 */
export const getPendingCounts = asyncHandler(async (req, res) => {
  const { site_id } = req.query;

  const siteFilter = site_id ? 'AND site_id = $1' : '';
  const fSiteFilter = site_id ? 'AND f.site_id = $1' : '';
  const params = site_id ? [parseInt(site_id)] : [];

  const queries = [
    pool.query(`SELECT COUNT(*)::int AS count FROM farmer_payments fp JOIN farmers f ON fp.farmer_id = f.id WHERE fp.status = 'pending' ${fSiteFilter}`, params),
    pool.query(`SELECT COUNT(*)::int AS count FROM plot_commissions WHERE status = 'pending' ${siteFilter}`, params),
    pool.query(`SELECT COUNT(*)::int AS count FROM plot_commission_payments WHERE status = 'pending' ${siteFilter}`, params),
    pool.query(`SELECT COUNT(*)::int AS count FROM cash_flow_entries WHERE status = 'pending' ${siteFilter}`, params),
    pool.query(`SELECT COUNT(*)::int AS count FROM firm_transactions WHERE status = 'pending' ${siteFilter}`, params),
    pool.query(`SELECT COUNT(*)::int AS count FROM plot_payments WHERE status = 'pending' ${siteFilter}`, params),
    pool.query(`SELECT COUNT(*)::int AS count FROM expenses WHERE status = 'pending' ${siteFilter}`, params),
    pool.query(`SELECT entry_type, COUNT(*)::int AS count FROM day_book WHERE status = 'pending' AND entry_type IN ('FARMER PAYMENT', 'PLOT COMMISSION', 'EXPENSE') ${siteFilter} GROUP BY entry_type`, params),
  ];

  const [fp, pc, pcp, cf, ft, pp, ex, db] = await Promise.all(queries);

  // Day book counts by entry_type
  const dbMap = {};
  for (const row of db.rows) dbMap[row.entry_type] = row.count;

  const fpCount = fp.rows[0].count + (dbMap['FARMER PAYMENT'] || 0);
  const pcCount = pc.rows[0].count + pcp.rows[0].count + (dbMap['PLOT COMMISSION'] || 0);
  const exCount = ex.rows[0].count + (dbMap['EXPENSE'] || 0);

  const counts = {
    farmer_payment: fpCount,
    plot_commission: pcCount,
    cash_flow_entry: cf.rows[0].count,
    firm_transaction: ft.rows[0].count,
    plot_payment: pp.rows[0].count,
    expense: exCount,
    total: fpCount + pcCount + cf.rows[0].count +
           ft.rows[0].count + pp.rows[0].count + exCount,
  };

  res.json(counts);
});

/**
 * PUT /approvals/:id/approve
 * Approve a single entry. source query param specifies the module.
 */
export const approveEntry = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { source } = req.query;

  if (!source || !ALLOWED_TABLES[source]) {
    return res.status(400).json({ message: 'source query param is required (farmer_payment, plot_commission, cash_flow_entry, firm_transaction, plot_payment, expense, daybook)' });
  }

  const table = getTableName(source);
  const entryId = parseInt(id);

  // Check current status
  const check = await pool.query(`SELECT status FROM ${table} WHERE id = $1`, [entryId]);
  if (!check.rows[0]) return res.status(404).json({ message: 'Entry not found' });
  if (check.rows[0].status === 'approved') return res.status(400).json({ message: 'Entry is already approved' });

  const result = await pool.query(
    `UPDATE ${table} SET status = 'approved', approved_by = $2, approved_at = NOW(), updated_at = NOW() WHERE id = $1 RETURNING *`,
    [entryId, req.user.id]
  );
  
  const entry = result.rows[0];

  // Auto-generate DayBook entry for new V2 commission payments
  if (source === 'plot_commission_payment' && parseFloat(entry.amount) > 0) {
    try {
      const pcpQuery = `
        SELECT pcp.*, p.plot_no, ag.full_name AS agent_name
        FROM plot_commission_payments pcp
        JOIN plot_commissions_v2 pcm ON pcp.plot_commission_id = pcm.id
        JOIN plots p ON pcm.plot_id = p.id
        JOIN members ag ON pcm.agent_id = ag.id
        WHERE pcp.id = $1
      `;
      const pcpData = await pool.query(pcpQuery, [entryId]);
      
      if (pcpData.rows.length > 0) {
        const pcpRow = pcpData.rows[0];
        const plotInfo = pcpRow.plot_no ? ` (Plot: ${pcpRow.plot_no})` : '';
        const dayBookQuery = `
          INSERT INTO day_book (site_id, date, particular, entry_type, debit, credit, remarks, payment_mode, category, to_entity, created_by, status)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'approved')
        `;
        await pool.query(dayBookQuery, [
          pcpRow.site_id,
          pcpRow.date,
          `${pcpRow.agent_name}${plotInfo} - COMMISSION`.toUpperCase(),
          'PLOT COMMISSION',
          pcpRow.amount,
          0,
          pcpRow.remarks,
          pcpRow.payment_mode ? pcpRow.payment_mode.toUpperCase() : 'CASH',
          'COMMISSION',
          pcpRow.agent_name,
          req.user.id
        ]);
      }
    } catch (dbErr) {
       console.error('[Approval] Failed to sync DayBook for Commission Payment:', dbErr.message);
    }
  }

  // Update overall commission status if full amount paid
  if (source === 'plot_commission_payment') {
      try {
          // get the total paid vs total commission
          const sumQuery = `
             SELECT 
                pcm.id, pcm.total_commission, 
                COALESCE(SUM(pcp.amount), 0) as total_paid
             FROM plot_commissions_v2 pcm
             LEFT JOIN plot_commission_payments pcp ON pcm.id = pcp.plot_commission_id AND pcp.status = 'approved'
             WHERE pcm.id = $1
             GROUP BY pcm.id
          `;
          const sumRes = await pool.query(sumQuery, [entry.plot_commission_id]);
          if (sumRes.rows.length > 0) {
              const { id, total_commission, total_paid } = sumRes.rows[0];
              let newStatus = 'Pending';
              if (Number(total_paid) > 0) {
                  newStatus = Number(total_paid) >= Number(total_commission) ? 'Completed' : 'Partial';
              }
              await pool.query(`UPDATE plot_commissions_v2 SET status = $1 WHERE id = $2`, [newStatus, id]);
          }
      } catch (err) {
         console.error('[Approval] Failed to calculate commission master status:', err.message);
      }
  }

  res.json({ entry, message: `${source} approved successfully` });
});

/**
 * PUT /approvals/:id/reject
 * Reject a single entry. source query param specifies the module.
 */
export const rejectEntry = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { source } = req.query;

  if (!source || !ALLOWED_TABLES[source]) {
    return res.status(400).json({ message: 'source query param is required' });
  }

  const table = getTableName(source);
  const entryId = parseInt(id);

  const check = await pool.query(`SELECT status FROM ${table} WHERE id = $1`, [entryId]);
  if (!check.rows[0]) return res.status(404).json({ message: 'Entry not found' });
  if (check.rows[0].status === 'rejected') return res.status(400).json({ message: 'Entry is already rejected' });

  const result = await pool.query(
    `UPDATE ${table} SET status = 'rejected', approved_by = $2, approved_at = NOW(), updated_at = NOW() WHERE id = $1 RETURNING *`,
    [entryId, req.user.id]
  );

  res.json({ entry: result.rows[0], message: `${source} rejected` });
});

/**
 * POST /approvals/bulk-approve
 * Approve multiple entries across modules at once.
 * Body: { items: [{ id, source }, ...] }
 */
export const bulkApprove = asyncHandler(async (req, res) => {
  const { items } = req.body;

  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ message: 'items array is required' });
  }

  // Group by source table
  const grouped = {};
  for (const item of items) {
    if (!ALLOWED_TABLES[item.source]) continue;
    const table = getTableName(item.source);
    if (!grouped[table]) grouped[table] = [];
    grouped[table].push(parseInt(item.id));
  }

  let totalApproved = 0;

  for (const [table, ids] of Object.entries(grouped)) {
    if (ids.length === 0) continue;
    const result = await pool.query(
      `UPDATE ${table} SET status = 'approved', approved_by = $2, approved_at = NOW(), updated_at = NOW()
       WHERE id = ANY($1::int[]) AND status = 'pending'
       RETURNING *`,
      [ids, req.user.id]
    );
    totalApproved += result.rowCount;
  }

  res.json({ message: `${totalApproved} entries approved successfully`, count: totalApproved });
});

/**
 * POST /approvals/bulk-reject
 * Reject multiple entries across modules at once.
 * Body: { items: [{ id, source }, ...] }
 */
export const bulkReject = asyncHandler(async (req, res) => {
  const { items } = req.body;

  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ message: 'items array is required' });
  }

  const grouped = {};
  for (const item of items) {
    if (!ALLOWED_TABLES[item.source]) continue;
    const table = getTableName(item.source);
    if (!grouped[table]) grouped[table] = [];
    grouped[table].push(parseInt(item.id));
  }

  let totalRejected = 0;

  for (const [table, ids] of Object.entries(grouped)) {
    if (ids.length === 0) continue;
    const result = await pool.query(
      `UPDATE ${table} SET status = 'rejected', approved_by = $2, approved_at = NOW(), updated_at = NOW()
       WHERE id = ANY($1::int[]) AND status = 'pending'
       RETURNING *`,
      [ids, req.user.id]
    );
    totalRejected += result.rowCount;
  }

  res.json({ message: `${totalRejected} entries rejected`, count: totalRejected });
});
