import asyncHandler from '../utils/asyncHandler.js';
import pool from '../config/db.js';
import {
  postApprovedImprestDebit,
  reverseApprovedImprestDebit,
} from '../services/imprestPosting.service.js';
import { notifyPlotPaymentRecorded } from '../utils/notify.js';
import { CHEQUE_STATUSES, updateChequeStatusRecord } from '../services/chequeStatus.service.js';

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
  plot_installment_payment: 'plot_installment_payments',
  expense: 'expenses',
  vendor_payment: 'vendor_payments',
  vendor_inventory_payment: 'vendor_inventory_payments',
  plot_registry_payment: 'plot_registry_payments',
  land_deal_payment: 'land_deal_payments', // Land Profit receipts (sub-module of farmers)
  misc_income_entry: 'misc_income_entries',
  daybook: 'day_book',
};

const SOURCE_BY_TABLE = Object.fromEntries(
  Object.entries(ALLOWED_TABLES).map(([source, table]) => [table, source])
);
const IMPREST_DEBIT_SOURCES = new Set([
  'expense', 'farmer_payment', 'plot_commission_payment', 'vendor_payment', 'vendor_inventory_payment', 'daybook',
]);

function getTableName(source) {
  const table = ALLOWED_TABLES[source];
  if (!table) throw new Error(`Invalid source: ${source}`);
  return table;
}

async function ensureInboundFirmTransferForApproval(entry, approverId) {
  if (!entry?.is_firm_to_firm_transfer) return;
  if ((entry.transfer_direction || '').toUpperCase() !== 'OUT') return;
  if (!entry.transfer_group_id || !entry.transfer_to_site_id || !entry.transfer_to_firm_id) return;

  const alreadyCreated = await pool.query(
    `SELECT id FROM firm_transactions WHERE transfer_group_id = $1 AND transfer_direction = 'IN' LIMIT 1`,
    [entry.transfer_group_id]
  );
  if (alreadyCreated.rows[0]) return;

  const sourceFirmRes = await pool.query(`SELECT id, name FROM firms WHERE id = $1`, [entry.firm_id]);
  const targetFirmRes = await pool.query(`SELECT id, name, site_id FROM firms WHERE id = $1`, [entry.transfer_to_firm_id]);

  const sourceFirm = sourceFirmRes.rows[0];
  const targetFirm = targetFirmRes.rows[0];
  if (!sourceFirm || !targetFirm) return;
  if (parseInt(targetFirm.site_id) !== parseInt(entry.transfer_to_site_id)) return;

  const transferAmount = Math.max(parseFloat(entry.debit) || 0, parseFloat(entry.credit) || 0);
  if (transferAmount <= 0) return;

  await pool.query(
    `INSERT INTO firm_transactions (
      firm_id,
      site_id,
      date,
      description,
      payment_mode,
      debit,
      credit,
      name,
      purpose,
      remark,
      cheque_no,
      created_by,
      voucher_url,
      assigned_admin_id,
      status,
      approved_by,
      approved_at,
      is_firm_to_firm_transfer,
      transfer_to_site_id,
      transfer_to_firm_id,
      transfer_group_id,
      transfer_direction
    ) VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'approved',$15,NOW(),true,$16,$17,$18,'IN'
    )`,
    [
      targetFirm.id,
      targetFirm.site_id,
      entry.date,
      `TRANSFER FROM ${sourceFirm.name}${entry.description ? ` - ${entry.description}` : ''}`,
      (entry.payment_mode || 'bank').toLowerCase() === 'cash' ? 'cash' : 'bank',
      0,
      transferAmount,
      sourceFirm.name,
      entry.purpose || 'FIRM TO FIRM TRANSFER',
      entry.remark || 'FIRM TO FIRM TRANSFER',
      entry.cheque_no || null,
      entry.created_by || null,
      entry.voucher_url || null,
      entry.assigned_admin_id || null,
      approverId,
      entry.site_id,
      entry.firm_id,
      entry.transfer_group_id,
    ]
  );
}

async function reconcileInstallmentPayment(paymentId) {
  const paymentRes = await pool.query(
    `SELECT installment_id FROM plot_installment_payments WHERE id = $1`,
    [paymentId]
  );
  const installmentId = paymentRes.rows[0]?.installment_id;
  if (!installmentId) return;
  await pool.query(
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
            AND financial_transaction_posts('credit', status, payment_mode, cheque_status)
       ) paid
      WHERE pi.id = $1`,
    [installmentId]
  );
}

async function resolveEntrySiteId(source, entry) {
  if (entry?.site_id) return entry.site_id;
  if (source === 'farmer_payment' && entry?.farmer_id) {
    const result = await pool.query('SELECT site_id FROM farmers WHERE id = $1', [entry.farmer_id]);
    return result.rows[0]?.site_id || null;
  }
  return null;
}

/**
 * For sub-admins, fetch allowed approval modules from user_approval_modules.
 * Admins get null (meaning all modules allowed).
 */
async function getAllowedModules(user) {
  if (user.role === 'admin' || user.role === 'super_admin') return null; // all allowed
  try {
    const result = await pool.query(
      'SELECT module FROM user_approval_modules WHERE user_id = $1',
      [user.id]
    );
    return new Set(result.rows.map(r => r.module));
  } catch {
    // Table may not exist yet — deny all
    return new Set();
  }
}

// Assignment is a routing preference for administrators, not an authority
// boundary. An admin or super-admin must always be able to clear a pending
// financial approval when the assigned reviewer is unavailable.
const hasGlobalApprovalOverride = (user) => user?.role === 'admin' || user?.role === 'super_admin';

/** Check if a module key is allowed (handles daybook sub-types too) */
function isModuleAllowed(allowed, moduleKey) {
  if (!allowed) return true; // admin — all allowed
  // daybook sub-types → check the 'daybook' module
  if (moduleKey === 'daybook_farmer' || moduleKey === 'daybook_commission' || moduleKey === 'daybook_expense' || moduleKey === 'daybook_general') {
    return allowed.has('daybook');
  }
  if (moduleKey === 'vendor_inventory_payment') return allowed.has('vendor_payment') || allowed.has('vendors');
  if (moduleKey === 'land_deal_payment') return allowed.has('farmer_payment');
  return allowed.has(moduleKey);
}

/**
 * Decide whether a sub-admin's pending-list query should include a module at all,
 * and whether it should be scoped to "assigned to me" rows only.
 *   - admin / super_admin → { include: true, scoped: false } (always full access)
 *   - sub-admin with module grant → { include: true, scoped: false }
 *   - sub-admin WITHOUT module grant → { include: true, scoped: true }
 *     (they still see entries delegated specifically to them)
 * `scoped: true` means the caller should add `AND <alias>.assigned_admin_id = user.id`.
 */
function moduleVisibility(user, allowed, moduleKey) {
  if (!allowed) return { include: true, scoped: false };
  if (isModuleAllowed(allowed, moduleKey)) return { include: true, scoped: false };
  return { include: true, scoped: true };
}

/**
 * GET /approvals/pending
 * List all pending entries across all modules.
 * Sub-admins only see modules they've been granted.
 */
export const listAllPending = asyncHandler(async (req, res) => {
  const { site_id, date_from, date_to, module, assigned_admin_id } = req.query;
  const allowedModules = await getAllowedModules(req.user);

  const results = [];

  // Helper to build WHERE clause.
  //   scopedAssigneeId: when set, forces assigned_admin_id = that user (used for sub-admins who
  //   don't hold a module grant but still need to see entries explicitly delegated to them).
  const buildWhere = (tableAlias, siteAlias, extraConditions = [], scopedAssigneeId = null, status = 'pending', dateColumn = 'date') => {
    const sAlias = siteAlias || tableAlias;
    const conditions = [`${tableAlias}.status = '${status}'`, ...extraConditions];
    const params = [];
    let idx = 1;
    if (site_id) {
      conditions.push(`${sAlias}.site_id = $${idx++}`);
      params.push(parseInt(site_id));
    }
    if (date_from) {
      conditions.push(`${tableAlias}.${dateColumn} >= $${idx++}`);
      params.push(date_from);
    }
    if (date_to) {
      conditions.push(`${tableAlias}.${dateColumn} <= $${idx++}`);
      params.push(date_to);
    }
    if (scopedAssigneeId) {
      conditions.push(`${tableAlias}.assigned_admin_id = $${idx++}`);
      params.push(parseInt(scopedAssigneeId));
    } else if (assigned_admin_id) {
      if (assigned_admin_id === 'unassigned') {
        conditions.push(`${tableAlias}.assigned_admin_id IS NULL`);
      } else {
        conditions.push(`${tableAlias}.assigned_admin_id = $${idx++}`);
        params.push(parseInt(assigned_admin_id));
      }
    }
    return { where: conditions.join(' AND '), params };
  };

  // 1. Farmer Payments (from farmer_payments table)
  const visFp = moduleVisibility(req.user, allowedModules, 'farmer_payment');
  if ((!module || module === 'farmer_payment') && visFp.include) {
    const { where, params } = buildWhere('fp', 'f', [], visFp.scoped ? req.user.id : null);
    const q = `
                  SELECT fp.*, f.name AS farmer_name, f.site_id,
                    f.name AS entity_name, 'Farmer / land owner'::text AS entity_type,
                    f.phone AS entity_phone, f.address AS entity_address,
                    NULL::text AS entity_plot_no,
                    s.name AS site_name, COALESCE(u.name, u.email) AS created_by_name,
                    COALESCE(aa.name, aa.email) AS assigned_admin_name,
             'farmer_payment' AS source
      FROM farmer_payments fp
      JOIN farmers f ON fp.farmer_id = f.id
      JOIN sites s ON f.site_id = s.id
      LEFT JOIN users u ON fp.created_by = u.id
            LEFT JOIN users aa ON fp.assigned_admin_id = aa.id
      WHERE ${where}
      ORDER BY fp.date DESC, fp.id DESC
    `;
    const r = await pool.query(q, params);
    results.push(...r.rows.map(row => ({
      ...row,
      entry_label: `${row.farmer_name} - ₹${row.amount}`,
      module_label: 'Lands Payment',
    })));
  }

  // 1b. Land sale receipts (Land Profit — sub-module of farmers, shares its grant and tab)
  const visLdp = moduleVisibility(req.user, allowedModules, 'land_deal_payment');
  if ((!module || module === 'farmer_payment' || module === 'land_deal_payment') && visLdp.include) {
    const { where, params } = buildWhere('ldp', 'ldp', [], visLdp.scoped ? req.user.id : null);
    const q = `
      SELECT ldp.*, d.buyer_name, d.deal_no, d.farmer_id,
             d.buyer_name AS entity_name, 'Land buyer'::text AS entity_type,
             d.buyer_phone AS entity_phone, NULL::text AS entity_address,
             NULL::text AS entity_plot_no,
             s.name AS site_name, COALESCE(u.name, u.email) AS created_by_name,
             COALESCE(aa.name, aa.email) AS assigned_admin_name,
             'land_deal_payment' AS source
      FROM land_deal_payments ldp
      JOIN land_deals d ON d.id = ldp.land_deal_id
      JOIN sites s ON s.id = ldp.site_id
      LEFT JOIN users u ON ldp.created_by = u.id
      LEFT JOIN users aa ON ldp.assigned_admin_id = aa.id
      WHERE ${where}
      ORDER BY ldp.date DESC, ldp.id DESC
    `;
    const r = await pool.query(q, params);
    results.push(...r.rows.map(row => ({
      ...row,
      entry_label: `LAND SALE - ${row.buyer_name} - ₹${row.amount}`,
      module_label: 'Land Sale Receipt',
    })));
  }

  // 1c. Miscellaneous income (its own approval module key: misc_income_entry)
  const visMie = moduleVisibility(req.user, allowedModules, 'misc_income_entry');
  if ((!module || module === 'misc_income_entry') && visMie.include) {
    const { where, params } = buildWhere('mie', 'mie', [], visMie.scoped ? req.user.id : null);
    const q = `
      SELECT mie.*, c.name AS category_name, c.color AS category_color,
             COALESCE(mie.party_name, c.name) AS entity_name,
             ('Misc income · ' || c.name)::text AS entity_type,
             NULL::text AS entity_phone, NULL::text AS entity_address, NULL::text AS entity_plot_no,
             s.name AS site_name, COALESCE(u.name, u.email) AS created_by_name,
             COALESCE(aa.name, aa.email) AS assigned_admin_name,
             'misc_income_entry' AS source
      FROM misc_income_entries mie
      JOIN misc_income_categories c ON c.id = mie.category_id
      JOIN sites s ON s.id = mie.site_id
      LEFT JOIN users u ON mie.created_by = u.id
      LEFT JOIN users aa ON mie.assigned_admin_id = aa.id
      WHERE ${where}
      ORDER BY mie.date DESC, mie.id DESC
    `;
    const r = await pool.query(q, params);
    results.push(...r.rows.map(row => ({
      ...row,
      // Debits are refunds: surface them as money out so the reviewer sees the direction.
      debit: row.direction === 'debit' ? row.amount : 0,
      credit: row.direction === 'debit' ? 0 : row.amount,
      entry_label: `${row.direction === 'debit' ? 'MISC INCOME REFUND' : 'MISC INCOME'} - ${row.category_name}${row.party_name ? ' - ' + row.party_name : ''} - ₹${row.amount}`,
      module_label: 'Misc Income',
    })));
  }

  // 2. Plot Commissions (Legacy)
  const visPc = moduleVisibility(req.user, allowedModules, 'plot_commission');
  if ((!module || module === 'plot_commission') && visPc.include) {
    const { where, params } = buildWhere('pc', 'pc', [], visPc.scoped ? req.user.id : null);
    const q = `
                  SELECT pc.*, pc.particular AS entity_name,
                    'Commission recipient'::text AS entity_type,
                    pc.plot_no AS entity_plot_no, pc.father_name AS entity_secondary,
                    s.name AS site_name, COALESCE(u.name, u.email) AS created_by_name,
                    COALESCE(aa.name, aa.email) AS assigned_admin_name,
             'plot_commission' AS source
      FROM plot_commissions pc
      JOIN sites s ON pc.site_id = s.id
      LEFT JOIN users u ON pc.created_by = u.id
            LEFT JOIN users aa ON pc.assigned_admin_id = aa.id
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
  const visPcp = moduleVisibility(req.user, allowedModules, 'plot_commission_payment');
  if ((!module || module === 'plot_commission_payment') && visPcp.include) {
    const { where, params } = buildWhere('pcp', 'pcp', [], visPcp.scoped ? req.user.id : null);
    const q = `
                  SELECT pcp.*, s.name AS site_name, COALESCE(u.name, u.email) AS created_by_name,
                    COALESCE(aa.name, aa.email) AS assigned_admin_name,
             p.plot_no, p.buyer_name, ag.full_name AS agent_name,
             ag.full_name AS entity_name, 'Commission agent'::text AS entity_type,
             p.plot_no AS entity_plot_no, p.buyer_name AS entity_secondary,
             'plot_commission_payment' AS source
      FROM plot_commission_payments pcp
      JOIN sites s ON pcp.site_id = s.id
      JOIN plot_commissions_v2 pcm ON pcp.plot_commission_id = pcm.id
      JOIN plots p ON pcm.plot_id = p.id
      JOIN members ag ON pcm.agent_id = ag.id
      LEFT JOIN users u ON pcp.created_by = u.id
            LEFT JOIN users aa ON pcp.assigned_admin_id = aa.id
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

  // 3. Cash Flow Entries (exclude trigger-synced duplicates from other modules)
  const visCfe = moduleVisibility(req.user, allowedModules, 'cash_flow_entry');
  if ((!module || module === 'cash_flow_entry') && visCfe.include) {
    const { where, params } = buildWhere('cfe', 'cfe', [], visCfe.scoped ? req.user.id : null);
    const q = `
                  SELECT cfe.*, cfe.site_id, s.name AS site_name, COALESCE(u.name, u.email) AS created_by_name,
                    COALESCE(aa.name, aa.email) AS assigned_admin_name,
             cfm.ledger_name, cfm.month, cfm.year, cfm.linked_user_id,
             lu.name AS linked_user_name, lu.email AS linked_user_email,
             COALESCE(lu.name, tf.name, cfe.to_name, ff.name, NULLIF(TRIM(cfm.ledger_name), ''), u.name, u.email, cfe.particular) AS entity_name,
             CASE
               WHEN lu.id IS NOT NULL THEN 'Mapped ledger user'
               WHEN tf.id IS NOT NULL OR ff.id IS NOT NULL THEN 'Firm / account'
               WHEN cfe.to_name IS NOT NULL THEN 'Ledger party'
               ELSE 'Personal ledger'
             END AS entity_type,
             COALESCE(lu.email, cfe.to_name, tf.name, ff.name) AS entity_secondary,
             NULL::text AS entity_plot_no,
             'cash_flow_entry' AS source
      FROM cash_flow_entries cfe
      JOIN sites s ON cfe.site_id = s.id
      JOIN cash_flow_months cfm ON cfe.cash_flow_month_id = cfm.id
      LEFT JOIN users lu ON lu.id = cfm.linked_user_id
      LEFT JOIN firms ff ON ff.id = cfe.from_firm_id
      LEFT JOIN firms tf ON tf.id = cfe.to_firm_id
      LEFT JOIN users u ON cfe.created_by = u.id
            LEFT JOIN users aa ON cfe.assigned_admin_id = aa.id
      WHERE ${where}
        AND cfe.source_module IS NULL
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
  const visFt = moduleVisibility(req.user, allowedModules, 'firm_transaction');
  if ((!module || module === 'firm_transaction') && visFt.include) {
    const { where, params } = buildWhere('ft', 'ft', [], visFt.scoped ? req.user.id : null);
    const q = `
                  SELECT ft.*, s.name AS site_name, COALESCE(u.name, u.email) AS created_by_name,
                    COALESCE(aa.name, aa.email) AS assigned_admin_name,
             fi.name AS firm_name,
             ts.name AS transfer_to_site_name,
             tf.name AS transfer_to_firm_name,
             COALESCE(ft.name, tf.name, fi.name) AS entity_name,
             CASE WHEN ft.is_firm_to_firm_transfer THEN 'Firm transfer' ELSE 'Firm transaction party' END AS entity_type,
             fi.name AS entity_secondary, NULL::text AS entity_plot_no,
             'firm_transaction' AS source
      FROM firm_transactions ft
      JOIN sites s ON ft.site_id = s.id
      JOIN firms fi ON ft.firm_id = fi.id
      LEFT JOIN sites ts ON ts.id = ft.transfer_to_site_id
      LEFT JOIN firms tf ON tf.id = ft.transfer_to_firm_id
      LEFT JOIN users u ON ft.created_by = u.id
            LEFT JOIN users aa ON ft.assigned_admin_id = aa.id
      WHERE ${where}
      ORDER BY ft.date DESC, ft.id DESC
    `;
    const r = await pool.query(q, params);
    results.push(...r.rows.map(row => ({
      ...row,
      entry_label: row.is_firm_to_firm_transfer
        ? `${row.firm_name} -> ${row.transfer_to_firm_name || row.name || 'Target'} (${row.transfer_to_site_name || 'Site'}) - ₹${parseFloat(row.debit) || parseFloat(row.credit) || 0}`
        : `${row.firm_name}: ${row.description} - Dr:₹${row.debit} Cr:₹${row.credit}`,
      module_label: 'Firm Transaction',
    })));
  }

  // 5. Plot Payments
  const visPp = moduleVisibility(req.user, allowedModules, 'plot_payment');
  if ((!module || module === 'plot_payment') && visPp.include) {
    const { where, params } = buildWhere('pp', 'pp', [], visPp.scoped ? req.user.id : null);
    const q = `
                  SELECT pp.*, pp.payment_type AS payment_mode, s.name AS site_name, COALESCE(u.name, u.email) AS created_by_name,
                    COALESCE(aa.name, aa.email) AS assigned_admin_name,
             p.plot_no, COALESCE(pp.buyer_name, p.buyer_name) AS buyer_name,
             COALESCE(pp.buyer_name, p.buyer_name, pp.payment_from, u.name, u.email, 'Plot ' || p.plot_no) AS entity_name,
             'Plot buyer / payer'::text AS entity_type,
             p.plot_no AS entity_plot_no, pp.payment_from AS entity_secondary,
             'plot_payment' AS source
      FROM plot_payments pp
      JOIN sites s ON pp.site_id = s.id
      JOIN plots p ON pp.plot_id = p.id
      LEFT JOIN users u ON pp.created_by = u.id
            LEFT JOIN users aa ON pp.assigned_admin_id = aa.id
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

  // 5b. Plot installment payments
  const visPip = moduleVisibility(req.user, allowedModules, 'plot_installment_payment');
  if ((!module || module === 'plot_installment_payment') && visPip.include) {
    const { where, params } = buildWhere('pip', 'p', [], visPip.scoped ? req.user.id : null, 'pending', 'payment_date');
    const q = `
      SELECT pip.*, pip.payment_date AS date, p.site_id, s.name AS site_name,
             COALESCE(u.name, u.email) AS created_by_name,
             COALESCE(aa.name, aa.email) AS assigned_admin_name,
             COALESCE(p.buyer_name, 'Plot ' || p.plot_no) AS entity_name,
             'Plot installment payer'::text AS entity_type,
             p.plot_no AS entity_plot_no, pi.installment_name AS entity_secondary,
             'plot_installment_payment' AS source
        FROM plot_installment_payments pip
        JOIN plot_installments pi ON pi.id = pip.installment_id
        JOIN plots p ON p.id = pip.plot_id
        JOIN sites s ON s.id = p.site_id
        LEFT JOIN users u ON u.id = pip.created_by
        LEFT JOIN users aa ON aa.id = pip.assigned_admin_id
       WHERE ${where}
       ORDER BY pip.payment_date DESC, pip.id DESC
    `;
    const r = await pool.query(q, params);
    results.push(...r.rows.map((row) => ({
      ...row,
      entry_label: `Plot ${row.entity_plot_no || 'N/A'} installment - ₹${row.amount}`,
      module_label: 'Plot Installment Payment',
    })));
  }

  // 6. Expenses
  const visEx = moduleVisibility(req.user, allowedModules, 'expense');
  if ((!module || module === 'expense') && visEx.include) {
    const { where, params } = buildWhere('e', 'e', [], visEx.scoped ? req.user.id : null);
    const q = `
                  SELECT e.*, s.name AS site_name, COALESCE(u.name, u.email) AS created_by_name,
                    COALESCE(aa.name, aa.email) AS assigned_admin_name,
             COALESCE(em.full_name, e.to_entity, e.from_entity, u.name, u.email) AS entity_name,
             CASE
               WHEN em.id IS NOT NULL THEN COALESCE(em.member_type, 'Member')
               WHEN e.to_entity IS NOT NULL OR e.from_entity IS NOT NULL THEN 'Expense party'
               ELSE 'Request creator (party not recorded)'
             END AS entity_type,
             COALESCE(e.category, e.from_entity) AS entity_secondary,
             NULL::text AS entity_plot_no,
             'expense' AS source
      FROM expenses e
      JOIN sites s ON e.site_id = s.id
      LEFT JOIN users u ON e.created_by = u.id
      LEFT JOIN members em ON em.id = e.assigned_user_id
            LEFT JOIN users aa ON e.assigned_admin_id = aa.id
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

  // 6b. Expenses already approved but still missing a voucher/bill. The
  // status='pending' query above stops tracking an expense the moment it's
  // approved, so a voucher gap would otherwise vanish from this list forever
  // instead of staying visible until someone uploads it.
  if ((!module || module === 'expense') && visEx.include) {
    const { where, params } = buildWhere('e', 'e', [
      `(e.voucher_url IS NULL OR e.voucher_url = '')`,
      `(e.bill_url IS NULL OR e.bill_url = '')`,
      // Only cash payments need a voucher — bank/UPI/cheque leave their own trail.
      `UPPER(COALESCE(NULLIF(e.payment_mode, ''), 'CASH')) = 'CASH'`,
    ], visEx.scoped ? req.user.id : null, 'approved');
    const q = `
                  SELECT e.*, s.name AS site_name, COALESCE(u.name, u.email) AS created_by_name,
                    COALESCE(aa.name, aa.email) AS assigned_admin_name,
             COALESCE(em.full_name, e.to_entity, e.from_entity, u.name, u.email) AS entity_name,
             CASE
               WHEN em.id IS NOT NULL THEN COALESCE(em.member_type, 'Member')
               WHEN e.to_entity IS NOT NULL OR e.from_entity IS NOT NULL THEN 'Expense party'
               ELSE 'Request creator (party not recorded)'
             END AS entity_type,
             COALESCE(e.category, e.from_entity) AS entity_secondary,
             NULL::text AS entity_plot_no,
             'expense' AS source
      FROM expenses e
      JOIN sites s ON e.site_id = s.id
      LEFT JOIN users u ON e.created_by = u.id
      LEFT JOIN members em ON em.id = e.assigned_user_id
            LEFT JOIN users aa ON e.assigned_admin_id = aa.id
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

  // 7. Vendor payments
  const visVp = moduleVisibility(req.user, allowedModules, 'vendor_payment');
  if ((!module || module === 'vendor_payment') && visVp.include) {
    const { where, params } = buildWhere('vp', 'vp', [], visVp.scoped ? req.user.id : null, 'pending', 'payment_date');
    const q = `
      SELECT vp.*, vp.payment_date AS date, s.name AS site_name,
             COALESCE(u.name, u.email) AS created_by_name,
             COALESCE(aa.name, aa.email) AS assigned_admin_name,
             vc.vendor_name AS entity_name, 'Vendor'::text AS entity_type,
             vc.work_title AS entity_secondary, NULL::text AS entity_plot_no,
             'vendor_payment' AS source
        FROM vendor_payments vp
        JOIN vendor_commitments vc ON vc.id = vp.commitment_id
        JOIN sites s ON s.id = vp.site_id
        LEFT JOIN users u ON u.id = vp.created_by
        LEFT JOIN users aa ON aa.id = vp.assigned_admin_id
       WHERE ${where}
       ORDER BY vp.payment_date DESC, vp.id DESC
    `;
    const r = await pool.query(q, params);
    results.push(...r.rows.map((row) => ({
      ...row,
      entry_label: `${row.entity_name || 'Vendor'} - ₹${row.amount}`,
      module_label: 'Vendor Payment',
    })));
  }

  // 8. Standalone registry payments. Linked rows inherit the source plot
  // payment's approval and therefore must not create a duplicate request.
  const visPrp = moduleVisibility(req.user, allowedModules, 'plot_registry_payment');
  if ((!module || module === 'plot_registry_payment') && visPrp.include) {
    const { where, params } = buildWhere(
      'prp', 'prp', ['prp.source_plot_payment_id IS NULL'],
      visPrp.scoped ? req.user.id : null, 'pending', 'payment_date'
    );
    const q = `
      SELECT prp.*, prp.payment_date AS date, s.name AS site_name,
             COALESCE(u.name, u.email) AS created_by_name,
             COALESCE(aa.name, aa.email) AS assigned_admin_name,
             COALESCE(pr.customer_name, 'Plot ' || pr.plot_no) AS entity_name,
             'Registry payer'::text AS entity_type,
             pr.plot_no AS entity_plot_no, pr.farmer_name AS entity_secondary,
             'plot_registry_payment' AS source
        FROM plot_registry_payments prp
        JOIN plot_registries pr ON pr.id = prp.registry_id
        JOIN sites s ON s.id = prp.site_id
        LEFT JOIN users u ON u.id = prp.created_by
        LEFT JOIN users aa ON aa.id = prp.assigned_admin_id
       WHERE ${where}
       ORDER BY prp.payment_date DESC, prp.id DESC
    `;
    const r = await pool.query(q, params);
    results.push(...r.rows.map((row) => ({
      ...row,
      entry_label: `Registry Plot ${row.entity_plot_no || 'N/A'} - ₹${row.amount}`,
      module_label: 'Registry Payment',
    })));
  }

  // 8b. Standalone inventory payments. Item allocations linked to a vendor
  // payment inherit that payment's decision and are not duplicate requests.
  const visVip = moduleVisibility(req.user, allowedModules, 'vendor_inventory_payment');
  if ((!module || module === 'vendor_inventory_payment') && visVip.include) {
    const { where, params } = buildWhere(
      'vip', 'vip', ['vip.source_vendor_payment_id IS NULL'],
      visVip.scoped ? req.user.id : null, 'pending', 'payment_date'
    );
    const q = `
      SELECT vip.*, vip.payment_date AS date, s.name AS site_name,
             COALESCE(u.name, u.email) AS created_by_name,
             COALESCE(aa.name, aa.email) AS assigned_admin_name,
             COALESCE(vio.vendor_name, vio.item_name) AS entity_name,
             'Vendor inventory'::text AS entity_type,
             vio.item_name AS entity_secondary, NULL::text AS entity_plot_no,
             'vendor_inventory_payment' AS source
        FROM vendor_inventory_payments vip
        JOIN vendor_inventory_orders vio ON vio.id = vip.order_id
        JOIN sites s ON s.id = vip.site_id
        LEFT JOIN users u ON u.id = vip.created_by
        LEFT JOIN users aa ON aa.id = vip.assigned_admin_id
       WHERE ${where}
       ORDER BY vip.payment_date DESC, vip.id DESC
    `;
    const r = await pool.query(q, params);
    results.push(...r.rows.map((row) => ({
      ...row,
      entry_label: `${row.entity_name || 'Inventory payment'} - ₹${row.amount}`,
      module_label: 'Vendor Inventory Payment',
    })));
  }

  // 9. Day Book entries (farmer payments, commissions, expenses auto-created in day_book)
  const visDb = moduleVisibility(req.user, allowedModules, 'daybook');
  if (visDb.include) {
    const DAYBOOK_TYPE_MAP = {
      'FARMER PAYMENT': 'daybook_farmer',
      'PLOT COMMISSION': 'daybook_commission',
      'EXPENSE': 'daybook_expense',
      'GENERAL': 'daybook_general',
    };
    const DAYBOOK_LABEL_MAP = {
      'FARMER PAYMENT': 'Farmer Payment (DayBook)',
      'PLOT COMMISSION': 'Plot Commission (DayBook)',
      'EXPENSE': 'Expense (DayBook)',
      'GENERAL': 'General Entry (DayBook)',
    };

    // Map module filter to entry_type
    let entryTypeFilter = `d.entry_type NOT IN ('CASH FLOW', 'FIRM TRANSACTION', 'PLOT PAYMENT', 'VENDOR PAYMENT')`;
    if (module === 'farmer_payment') entryTypeFilter = `d.entry_type = 'FARMER PAYMENT'`;
    else if (module === 'plot_commission') entryTypeFilter = `d.entry_type = 'PLOT COMMISSION'`;
    else if (module === 'expense') entryTypeFilter = `d.entry_type = 'EXPENSE'`;
    else if (module && !['farmer_payment', 'plot_commission', 'expense'].includes(module)) entryTypeFilter = null;

    if (entryTypeFilter) {
      const { where, params } = buildWhere('d', 'd', [], visDb.scoped ? req.user.id : null);
      const q = `
            SELECT d.*, s.name AS site_name, COALESCE(u.name, u.email) AS created_by_name,
              COALESCE(aa.name, aa.email) AS assigned_admin_name,
              COALESCE(
                dm.full_name, df.name, dpc.particular, dlu.name,
                dpp.buyer_name, dp.buyer_name, dft.name, dfi.name,
                d.to_entity, d.from_entity, dcfm.ledger_name,
                u.name, u.email, d.particular
              ) AS entity_name,
              CASE
                WHEN dm.id IS NOT NULL THEN COALESCE(dm.member_type, 'Member')
                WHEN df.id IS NOT NULL THEN 'Farmer / land owner'
                WHEN dpc.id IS NOT NULL THEN 'Commission recipient'
                WHEN dlu.id IS NOT NULL THEN 'Mapped ledger user'
                WHEN dpp.id IS NOT NULL THEN 'Plot buyer / payer'
                WHEN dft.id IS NOT NULL THEN 'Firm transaction party'
                WHEN d.cash_flow_entry_id IS NOT NULL THEN 'Personal ledger'
                ELSE 'Day Book entity'
              END AS entity_type,
              COALESCE(dlu.email, dcfm.ledger_name, d.category) AS entity_secondary,
              COALESCE(dpc.plot_no, dp.plot_no)::text AS entity_plot_no,
               'daybook' AS source
        FROM day_book d
        JOIN sites s ON d.site_id = s.id
        LEFT JOIN users u ON d.created_by = u.id
        LEFT JOIN users aa ON d.assigned_admin_id = aa.id
        LEFT JOIN members dm ON dm.id = d.assigned_user_id
        LEFT JOIN farmer_payments dfp ON dfp.id = d.farmer_payment_id
        LEFT JOIN farmers df ON df.id = dfp.farmer_id
        LEFT JOIN plot_commissions dpc ON dpc.id = d.commission_id
        LEFT JOIN cash_flow_entries dcfe ON dcfe.id = d.cash_flow_entry_id
        LEFT JOIN cash_flow_months dcfm ON dcfm.id = dcfe.cash_flow_month_id
        LEFT JOIN users dlu ON dlu.id = dcfm.linked_user_id
        LEFT JOIN firm_transactions dft ON dft.id = d.firm_transaction_id
        LEFT JOIN firms dfi ON dfi.id = dft.firm_id
        LEFT JOIN plot_payments dpp ON dpp.id = d.plot_payment_id
        LEFT JOIN plots dp ON dp.id = dpp.plot_id
        -- Farmer Payments create matching Day Book entries for accounting.  The
        -- farmer payment itself is the approval request, so do not show that
        -- linked accounting mirror as a second request.
        WHERE ${where} AND ${entryTypeFilter}
          AND (d.entry_type <> 'FARMER PAYMENT' OR d.farmer_payment_id IS NULL)
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
 * Get pending counts per module.
 * Sub-admins only see counts for their allowed modules.
 */
export const getPendingCounts = asyncHandler(async (req, res) => {
  const { site_id } = req.query;
  const allowedModules = await getAllowedModules(req.user);

  // Build an "assigned to me" clause for sub-admins lacking module grants —
  // they still need counts for entries delegated directly to them.
  const isSubAdmin = req.user.role === 'sub_admin';
  const scopeClauseFor = (alias, moduleKey) => {
    if (!isSubAdmin) return '';
    if (isModuleAllowed(allowedModules, moduleKey)) return '';
    return ` AND ${alias}.assigned_admin_id = ${parseInt(req.user.id)}`;
  };

  const siteFilter = site_id ? 'AND site_id = $1' : '';
  const fSiteFilter = site_id ? 'AND f.site_id = $1' : '';
  const params = site_id ? [parseInt(site_id)] : [];

  const queries = [
    pool.query(`SELECT COUNT(*)::int AS count FROM farmer_payments fp JOIN farmers f ON fp.farmer_id = f.id WHERE fp.status = 'pending' ${fSiteFilter}${scopeClauseFor('fp', 'farmer_payment')}`, params),
    pool.query(`SELECT COUNT(*)::int AS count FROM plot_commissions pc WHERE pc.status = 'pending' ${site_id ? 'AND pc.site_id = $1' : ''}${scopeClauseFor('pc', 'plot_commission')}`, params),
    pool.query(`SELECT COUNT(*)::int AS count FROM plot_commission_payments pcp WHERE pcp.status = 'pending' ${site_id ? 'AND pcp.site_id = $1' : ''}${scopeClauseFor('pcp', 'plot_commission_payment')}`, params),
    pool.query(`SELECT COUNT(*)::int AS count FROM cash_flow_entries cfe WHERE cfe.status = 'pending' AND cfe.source_module IS NULL ${site_id ? 'AND cfe.site_id = $1' : ''}${scopeClauseFor('cfe', 'cash_flow_entry')}`, params),
    pool.query(`SELECT COUNT(*)::int AS count FROM firm_transactions ft WHERE ft.status = 'pending' ${site_id ? 'AND ft.site_id = $1' : ''}${scopeClauseFor('ft', 'firm_transaction')}`, params),
    pool.query(`SELECT COUNT(*)::int AS count FROM plot_payments pp WHERE pp.status = 'pending' ${site_id ? 'AND pp.site_id = $1' : ''}${scopeClauseFor('pp', 'plot_payment')}`, params),
    pool.query(`SELECT COUNT(*)::int AS count FROM plot_installment_payments pip JOIN plots p ON p.id = pip.plot_id WHERE pip.status = 'pending' ${site_id ? 'AND p.site_id = $1' : ''}${scopeClauseFor('pip', 'plot_installment_payment')}`, params),
    pool.query(`SELECT COUNT(*)::int AS count FROM expenses e WHERE e.status = 'pending' ${site_id ? 'AND e.site_id = $1' : ''}${scopeClauseFor('e', 'expense')}`, params),
    pool.query(`SELECT COUNT(*)::int AS count FROM vendor_payments vp WHERE vp.status = 'pending' ${site_id ? 'AND vp.site_id = $1' : ''}${scopeClauseFor('vp', 'vendor_payment')}`, params),
    pool.query(`SELECT COUNT(*)::int AS count FROM vendor_inventory_payments vip WHERE vip.status = 'pending' AND vip.source_vendor_payment_id IS NULL ${site_id ? 'AND vip.site_id = $1' : ''}${scopeClauseFor('vip', 'vendor_inventory_payment')}`, params),
    pool.query(`SELECT COUNT(*)::int AS count FROM plot_registry_payments prp WHERE prp.status = 'pending' AND prp.source_plot_payment_id IS NULL ${site_id ? 'AND prp.site_id = $1' : ''}${scopeClauseFor('prp', 'plot_registry_payment')}`, params),
    // Linked farmer-payment Day Book rows are accounting mirrors, not separate
    // approval requests. Keep the count consistent with /approvals/pending.
    pool.query(`SELECT entry_type, COUNT(*)::int AS count FROM day_book d WHERE d.status = 'pending' AND d.entry_type NOT IN ('CASH FLOW', 'FIRM TRANSACTION', 'PLOT PAYMENT', 'VENDOR PAYMENT') AND (d.entry_type <> 'FARMER PAYMENT' OR d.farmer_payment_id IS NULL) ${site_id ? 'AND d.site_id = $1' : ''}${scopeClauseFor('d', 'daybook')} GROUP BY entry_type`, params),
    // Land sale receipts share the farmer tab (same grant), see fpCount below.
    pool.query(`SELECT COUNT(*)::int AS count FROM land_deal_payments ldp WHERE ldp.status = 'pending' ${site_id ? 'AND ldp.site_id = $1' : ''}${scopeClauseFor('ldp', 'land_deal_payment')}`, params),
    pool.query(`SELECT COUNT(*)::int AS count FROM misc_income_entries mie WHERE mie.status = 'pending' ${site_id ? 'AND mie.site_id = $1' : ''}${scopeClauseFor('mie', 'misc_income_entry')}`, params),
  ];

  const [fp, pc, pcp, cf, ft, pp, pip, ex, vp, vip, prp, db, ldp, mie] = await Promise.all(queries);

  // Day book counts by entry_type
  const dbMap = {};
  for (const row of db.rows) dbMap[row.entry_type] = row.count;

  // "Visible" check — admin / granted module / scoped sub-admin all count as visible.
  // Scoped queries above already restricted to assigned-to-me rows, so their raw count is safe.
  const a = (mod) => !allowedModules || isModuleAllowed(allowedModules, mod) || isSubAdmin;

  const fpCount = a('farmer_payment') ? fp.rows[0].count + ldp.rows[0].count + (a('daybook') ? (dbMap['FARMER PAYMENT'] || 0) : 0) : 0;
  const pcCount = a('plot_commission') || a('plot_commission_payment')
    ? (a('plot_commission') ? pc.rows[0].count : 0) + (a('plot_commission_payment') ? pcp.rows[0].count : 0) + (a('daybook') ? (dbMap['PLOT COMMISSION'] || 0) : 0)
    : 0;
  const exCount = a('expense') ? ex.rows[0].count + (a('daybook') ? (dbMap['EXPENSE'] || 0) : 0) : 0;
  const cfCount = a('cash_flow_entry') ? cf.rows[0].count + (a('daybook') ? Object.entries(dbMap)
    .filter(([et]) => !['FARMER PAYMENT', 'PLOT COMMISSION', 'EXPENSE'].includes(et))
    .reduce((sum, [, count]) => sum + count, 0) : 0) : 0;
  const ftCount = a('firm_transaction') ? ft.rows[0].count : 0;
  const ppCount = a('plot_payment') ? pp.rows[0].count : 0;
  const pipCount = a('plot_installment_payment') ? pip.rows[0].count : 0;
  const vpCount = a('vendor_payment') ? vp.rows[0].count : 0;
  const vipCount = a('vendor_inventory_payment') ? vip.rows[0].count : 0;
  const prpCount = a('plot_registry_payment') ? prp.rows[0].count : 0;
  const mieCount = a('misc_income_entry') ? mie.rows[0].count : 0;

  const counts = {
    farmer_payment: fpCount,
    plot_commission: pcCount,
    cash_flow_entry: cfCount,
    firm_transaction: ftCount,
    plot_payment: ppCount,
    plot_installment_payment: pipCount,
    expense: exCount,
    vendor_payment: vpCount,
    vendor_inventory_payment: vipCount,
    plot_registry_payment: prpCount,
    misc_income_entry: mieCount,
    total: fpCount + pcCount + cfCount + ftCount + ppCount + pipCount + exCount + vpCount + vipCount + prpCount + mieCount,
  };

  res.json({ ...counts, allowed_modules: allowedModules ? Array.from(allowedModules) : null });
});

/**
 * PUT /approvals/:id/approve
 * Approve a single entry. source query param specifies the module.
 */
export const approveEntry = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { source } = req.query;

  if (!source || !ALLOWED_TABLES[source]) {
    return res.status(400).json({ message: 'A valid financial source query param is required' });
  }

  const table = getTableName(source);
  const entryId = parseInt(id);

  // Check current status + assignment up-front — assignment overrides module-level permission,
  // so a sub-admin can approve an entry that was explicitly delegated to them even without a
  // blanket module grant.
  const check = await pool.query(`SELECT status, assigned_admin_id FROM ${table} WHERE id = $1`, [entryId]);
  if (!check.rows[0]) return res.status(404).json({ message: 'Entry not found' });
  if (check.rows[0].status === 'approved') return res.status(400).json({ message: 'Entry is already approved' });

  const assignedTo = check.rows[0].assigned_admin_id ? parseInt(check.rows[0].assigned_admin_id) : null;
  const isAssignedToCaller = assignedTo === parseInt(req.user.id);

  if (!hasGlobalApprovalOverride(req.user) && !isAssignedToCaller) {
    if (assignedTo) {
      return res.status(403).json({ message: 'This entry is assigned to another user for approval' });
    }
    const allowedModules = await getAllowedModules(req.user);
    if (!isModuleAllowed(allowedModules, source)) {
      return res.status(403).json({ message: 'You do not have permission to approve this module' });
    }
  }

  const result = await pool.query(
    `UPDATE ${table} SET status = 'approved', approved_by = $2, approved_at = NOW(), updated_at = NOW() WHERE id = $1 RETURNING *`,
    [entryId, req.user.id]
  );
  
  const entry = result.rows[0];

  if (source === 'firm_transaction') {
    await ensureInboundFirmTransferForApproval(entry, req.user.id);
  }
  if (source === 'plot_installment_payment') {
    await reconcileInstallmentPayment(entryId);
  }
  if (source === 'vendor_payment') {
    await pool.query(
      `UPDATE vendor_inventory_payments
          SET status = 'approved', approved_by = $2, approved_at = NOW(),
              cheque_status = $3, cheque_no = $4, updated_at = NOW()
        WHERE source_vendor_payment_id = $1`,
      [entryId, req.user.id, entry.cheque_status || null, entry.cheque_no || null]
    );
  }
  if (source === 'plot_payment'
    && !['BOUNCED', 'RETURNED'].includes(String(entry.cheque_status || '').toUpperCase())) {
    notifyPlotPaymentRecorded(entry).catch((error) => {
      console.error('[Approval] Plot payment notification failed:', error?.message || error);
    });
  }

  if (IMPREST_DEBIT_SOURCES.has(source)) {
    const siteId = await resolveEntrySiteId(source, entry);
    await postApprovedImprestDebit({
      createdBy: entry.created_by,
      amount: parseFloat(entry.debit || entry.amount) || 0,
      referenceId: entryId,
      sourceModule: source,
      remarks: `${source.toUpperCase()} #${entryId}`,
      approvedBy: req.user.id,
      siteId,
      proofKey: entry.imprest_proof_key,
    });
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
             LEFT JOIN plot_commission_payments pcp ON pcm.id = pcp.plot_commission_id
               AND financial_transaction_posts(CASE WHEN pcp.amount < 0 THEN 'credit' ELSE 'debit' END, pcp.status, pcp.payment_mode, pcp.cheque_status)
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

  const check = await pool.query(`SELECT status, assigned_admin_id, created_by FROM ${table} WHERE id = $1`, [entryId]);
  if (!check.rows[0]) return res.status(404).json({ message: 'Entry not found' });
  if (check.rows[0].status === 'rejected') return res.status(400).json({ message: 'Entry is already rejected' });

  const assignedTo = check.rows[0].assigned_admin_id ? parseInt(check.rows[0].assigned_admin_id) : null;
  const isAssignedToCaller = assignedTo === parseInt(req.user.id);

  if (!hasGlobalApprovalOverride(req.user) && !isAssignedToCaller) {
    if (assignedTo) {
      return res.status(403).json({ message: 'This entry is assigned to another user for approval' });
    }
    const allowedModules = await getAllowedModules(req.user);
    if (!isModuleAllowed(allowedModules, source)) {
      return res.status(403).json({ message: 'You do not have permission to reject this module' });
    }
  }

  const wasApproved = check.rows[0].status === 'approved';

  const result = await pool.query(
    `UPDATE ${table} SET status = 'rejected', approved_by = $2, approved_at = NOW(), updated_at = NOW() WHERE id = $1 RETURNING *`,
    [entryId, req.user.id]
  );

  if (source === 'plot_installment_payment') {
    await reconcileInstallmentPayment(entryId);
  }
  if (source === 'vendor_payment') {
    await pool.query(
      `UPDATE vendor_inventory_payments
          SET status = 'rejected', approved_by = $2, approved_at = NOW(), updated_at = NOW()
        WHERE source_vendor_payment_id = $1`,
      [entryId, req.user.id]
    );
  }

  // Reverse imprest deduction if entry was previously approved.
  const IMPREST_SOURCES = ['expense', 'farmer_payment', 'plot_commission_payment', 'vendor_payment', 'daybook'];
  if (wasApproved && IMPREST_SOURCES.includes(source)) {
    const entry = result.rows[0];
    const debitAmount = parseFloat(entry.debit || entry.amount) || 0;
    const siteId = await resolveEntrySiteId(source, entry);
    await reverseApprovedImprestDebit({
      createdBy: entry.created_by,
      amount: debitAmount,
      referenceId: entryId,
      sourceModule: source,
      remarks: `${source.toUpperCase()} #${entryId}`,
      reversedBy: req.user.id,
      siteId,
    });
  }

  // Update overall commission status if plot_commission_payment was rejected
  if (source === 'plot_commission_payment') {
    const entry = result.rows[0];
    if (entry.plot_commission_id) {
      try {
        const sumQuery = `
          SELECT 
            pcm.id, pcm.total_commission, 
            COALESCE(SUM(pcp.amount), 0) as total_paid
          FROM plot_commissions_v2 pcm
          LEFT JOIN plot_commission_payments pcp ON pcm.id = pcp.plot_commission_id
            AND financial_transaction_posts(CASE WHEN pcp.amount < 0 THEN 'credit' ELSE 'debit' END, pcp.status, pcp.payment_mode, pcp.cheque_status)
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
        console.error('[Approval] Failed to update commission status after rejection:', err.message);
      }
    }
  }

  res.json({ entry: result.rows[0], message: `${source} rejected` });
});

/**
 * PUT /approvals/:id/voucher
 * Attach an already-uploaded voucher/bill URL to an entry, from the pending
 * lookout queue — every source table carries a `voucher_url` column, so one
 * write clears the "missing voucher" flag regardless of module.
 * Body: { voucher_url }
 */
export const attachVoucher = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { source } = req.query;
  const { voucher_url } = req.body;

  if (!source || !ALLOWED_TABLES[source]) {
    return res.status(400).json({ message: 'source query param is required' });
  }
  if (!voucher_url || typeof voucher_url !== 'string') {
    return res.status(400).json({ message: 'voucher_url is required' });
  }

  const table = getTableName(source);
  const entryId = parseInt(id);

  const check = await pool.query(`SELECT id, assigned_admin_id FROM ${table} WHERE id = $1`, [entryId]);
  if (!check.rows[0]) return res.status(404).json({ message: 'Entry not found' });

  const assignedTo = check.rows[0].assigned_admin_id ? parseInt(check.rows[0].assigned_admin_id) : null;
  const isAssignedToCaller = assignedTo === parseInt(req.user.id);
  if (!hasGlobalApprovalOverride(req.user) && !isAssignedToCaller) {
    if (assignedTo) {
      return res.status(403).json({ message: 'This entry is assigned to another user' });
    }
    const allowedModules = await getAllowedModules(req.user);
    if (!isModuleAllowed(allowedModules, source)) {
      return res.status(403).json({ message: 'You do not have permission to update this module' });
    }
  }

  const result = await pool.query(
    `UPDATE ${table} SET voucher_url = $2, updated_at = NOW() WHERE id = $1 RETURNING *`,
    [entryId, voucher_url]
  );
  res.json({ entry: result.rows[0], message: 'Voucher attached' });
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
  let skippedAssignedToOthers = 0;
  const affectedCommissions = new Set();
  const canOverrideAssignment = hasGlobalApprovalOverride(req.user);

  for (const [table, ids] of Object.entries(grouped)) {
    if (ids.length === 0) continue;
    const assignmentClause = canOverrideAssignment
      ? ''
      : ' AND (assigned_admin_id IS NULL OR assigned_admin_id = $3)';
    const result = await pool.query(
      `UPDATE ${table} SET status = 'approved', approved_by = $2, approved_at = NOW(), updated_at = NOW()
       WHERE id = ANY($1::int[]) AND status = 'pending'${assignmentClause}
       RETURNING *`,
      canOverrideAssignment ? [ids, req.user.id] : [ids, req.user.id, req.user.id]
    );

    if (table === 'firm_transactions') {
      for (const row of result.rows) {
        await ensureInboundFirmTransferForApproval(row, req.user.id);
      }
    }
    if (table === 'plot_installment_payments') {
      for (const row of result.rows) await reconcileInstallmentPayment(row.id);
    }
    if (table === 'vendor_payments' && result.rows.length > 0) {
      await pool.query(
        `UPDATE vendor_inventory_payments vip
            SET status = 'approved', approved_by = $2, approved_at = NOW(),
                cheque_status = vp.cheque_status, cheque_no = vp.cheque_no, updated_at = NOW()
           FROM vendor_payments vp
          WHERE vip.source_vendor_payment_id = vp.id
            AND vp.id = ANY($1::int[])`,
        [result.rows.map((row) => row.id), req.user.id]
      );
    }
    if (table === 'plot_payments') {
      for (const row of result.rows) {
        if (!['BOUNCED', 'RETURNED'].includes(String(row.cheque_status || '').toUpperCase())) {
          notifyPlotPaymentRecorded(row).catch((error) => {
            console.error('[Approval] Plot payment notification failed:', error?.message || error);
          });
        }
      }
    }
    const sourceKey = SOURCE_BY_TABLE[table];
    if (IMPREST_DEBIT_SOURCES.has(sourceKey)) {
      for (const row of result.rows) {
        const siteId = await resolveEntrySiteId(sourceKey, row);
        await postApprovedImprestDebit({
          createdBy: row.created_by,
          amount: parseFloat(row.debit || row.amount) || 0,
          referenceId: row.id,
          sourceModule: sourceKey,
          remarks: `${sourceKey.toUpperCase()} #${row.id}`,
          approvedBy: req.user.id,
          siteId,
          proofKey: row.imprest_proof_key,
        });
      }
    }

    // Track plot commission payments for status update
    if (table === 'plot_commission_payments') {
      for (const row of result.rows) {
        if (row.plot_commission_id) {
          affectedCommissions.add(row.plot_commission_id);
        }
      }
    }
    totalApproved += result.rowCount;
    skippedAssignedToOthers += (ids.length - result.rowCount);
  }

  // Update commission statuses for all affected commissions
  if (affectedCommissions.size > 0) {
    try {
      for (const commissionId of affectedCommissions) {
        const sumQuery = `
          SELECT 
            pcm.id, pcm.total_commission, 
            COALESCE(SUM(pcp.amount), 0) as total_paid
          FROM plot_commissions_v2 pcm
          LEFT JOIN plot_commission_payments pcp ON pcm.id = pcp.plot_commission_id
            AND financial_transaction_posts(CASE WHEN pcp.amount < 0 THEN 'credit' ELSE 'debit' END, pcp.status, pcp.payment_mode, pcp.cheque_status)
          WHERE pcm.id = $1
          GROUP BY pcm.id
        `;
        const sumRes = await pool.query(sumQuery, [commissionId]);
        if (sumRes.rows.length > 0) {
          const { id, total_commission, total_paid } = sumRes.rows[0];
          let newStatus = 'Pending';
          if (Number(total_paid) > 0) {
            newStatus = Number(total_paid) >= Number(total_commission) ? 'Completed' : 'Partial';
          }
          await pool.query(`UPDATE plot_commissions_v2 SET status = $1 WHERE id = $2`, [newStatus, id]);
        }
      }
    } catch (err) {
      console.error('[Approval] Failed to update commission statuses in bulk approve:', err.message);
    }
  }

  const msg = skippedAssignedToOthers > 0
    ? `${totalApproved} entries approved, ${skippedAssignedToOthers} skipped (assigned to other admins)`
    : `${totalApproved} entries approved successfully`;
  res.json({ message: msg, count: totalApproved, skippedAssignedToOthers });
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
  let skippedAssignedToOthers = 0;
  const affectedCommissions = new Set();
  const canOverrideAssignment = hasGlobalApprovalOverride(req.user);

  for (const [table, ids] of Object.entries(grouped)) {
    if (ids.length === 0) continue;
    const assignmentClause = canOverrideAssignment
      ? ''
      : ' AND (assigned_admin_id IS NULL OR assigned_admin_id = $3)';
    const result = await pool.query(
      `UPDATE ${table} SET status = 'rejected', approved_by = $2, approved_at = NOW(), updated_at = NOW()
       WHERE id = ANY($1::int[]) AND status = 'pending'${assignmentClause}
       RETURNING *`,
      canOverrideAssignment ? [ids, req.user.id] : [ids, req.user.id, req.user.id]
    );

    // Track plot commission payments for status update
    if (table === 'plot_commission_payments') {
      for (const row of result.rows) {
        if (row.plot_commission_id) {
          affectedCommissions.add(row.plot_commission_id);
        }
      }
    }
    if (table === 'plot_installment_payments') {
      for (const row of result.rows) await reconcileInstallmentPayment(row.id);
    }
    if (table === 'vendor_payments' && result.rows.length > 0) {
      await pool.query(
        `UPDATE vendor_inventory_payments
            SET status = 'rejected', approved_by = $2, approved_at = NOW(), updated_at = NOW()
          WHERE source_vendor_payment_id = ANY($1::int[])`,
        [result.rows.map((row) => row.id), req.user.id]
      );
    }

    totalRejected += result.rowCount;
    skippedAssignedToOthers += (ids.length - result.rowCount);
  }

  // Update commission statuses for all affected commissions
  if (affectedCommissions.size > 0) {
    try {
      for (const commissionId of affectedCommissions) {
        const sumQuery = `
          SELECT 
            pcm.id, pcm.total_commission, 
            COALESCE(SUM(pcp.amount), 0) as total_paid
          FROM plot_commissions_v2 pcm
          LEFT JOIN plot_commission_payments pcp ON pcm.id = pcp.plot_commission_id
            AND financial_transaction_posts(CASE WHEN pcp.amount < 0 THEN 'credit' ELSE 'debit' END, pcp.status, pcp.payment_mode, pcp.cheque_status)
          WHERE pcm.id = $1
          GROUP BY pcm.id
        `;
        const sumRes = await pool.query(sumQuery, [commissionId]);
        if (sumRes.rows.length > 0) {
          const { id, total_commission, total_paid } = sumRes.rows[0];
          let newStatus = 'Pending';
          if (Number(total_paid) > 0) {
            newStatus = Number(total_paid) >= Number(total_commission) ? 'Completed' : 'Partial';
          }
          await pool.query(`UPDATE plot_commissions_v2 SET status = $1 WHERE id = $2`, [newStatus, id]);
        }
      }
    } catch (err) {
      console.error('[Approval] Failed to update commission statuses in bulk reject:', err.message);
    }
  }

  const msg = skippedAssignedToOthers > 0
    ? `${totalRejected} entries rejected, ${skippedAssignedToOthers} skipped (assigned to other admins)`
    : `${totalRejected} entries rejected`;
  res.json({ message: msg, count: totalRejected, skippedAssignedToOthers });
});

// ══════════════════════════════════════════════════
//  CHEQUE STATUS UPDATE (Admin)
// ══════════════════════════════════════════════════

/**
 * GET /approvals/cheques
 * List all cheque entries across modules (for admin cheque management tab).
 * Query: ?site_id=X&status=PENDING|CLEARED|BOUNCED|RETURNED|all
 */
export const listChequeEntries = asyncHandler(async (req, res) => {
  const { site_id, status } = req.query;

  const statusFilter = status && status !== 'all' ? status.toUpperCase() : null;
  // Migration 104 adds this link so an inventory allocation is not listed a
  // second time beside its parent vendor payment. Older databases do not have
  // the column yet; detect that shape so the whole cheque dashboard remains
  // usable while they are upgraded.
  const inventoryColumnResult = await pool.query(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'vendor_inventory_payments'
          AND column_name = 'source_vendor_payment_id'
     ) AS has_source_vendor_payment_id,
     EXISTS (
       SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'vendor_inventory_payments'
          AND column_name = 'cheque_status'
     ) AS has_cheque_status`
  );
  const inventoryColumns = inventoryColumnResult.rows[0] || {};
  const inventorySourceFilter = inventoryColumns.has_source_vendor_payment_id
    ? ' AND t.source_vendor_payment_id IS NULL'
    : '';
  const inventorySupportsChequeStatus = Boolean(inventoryColumns.has_cheque_status);

  // Build UNION ALL query across all relevant tables
  const queries = [];
  const params = [];
  let paramIdx = 0;

  const addQuery = (table, source, labelExpr, siteCol = 'site_id') => {
    paramIdx++;
    const siteParam = site_id ? `AND t.${siteCol} = $${paramIdx}` : '';
    const statusParam = statusFilter ? `AND t.cheque_status = $${paramIdx + (site_id ? 0 : 0)}` : '';

    // Build WHERE parts dynamically
    const whereParts = ['t.cheque_status IS NOT NULL'];
    if (site_id) { params.push(parseInt(site_id)); whereParts.push(`t.${siteCol} = $${params.length}`); }
    if (statusFilter) { params.push(statusFilter); whereParts.push(`t.cheque_status = $${params.length}`); }

    const debitCol = table === 'firm_transactions' ? 'debit' : table === 'plot_commission_payments' ? 'amount' : table === 'plot_payments' ? 'amount' : table === 'plot_registry_payments' ? 'amount' : 'debit';
    const creditCol = table === 'firm_transactions' ? 'credit' : table === 'plot_commission_payments' ? '0' : table === 'plot_payments' ? '0' : table === 'plot_registry_payments' ? '0' : 'credit';

    queries.push(`
      SELECT t.id, '${source}' AS source, ${labelExpr} AS entry_label,
        COALESCE(t.${debitCol}, 0)::numeric AS debit, COALESCE(t.${creditCol}, 0)::numeric AS credit,
        t.cheque_no, t.cheque_status, t.date,
        t.${siteCol} AS site_id, s.name AS site_name,
        t.created_at, t.updated_at
      FROM ${table} t
      LEFT JOIN sites s ON s.id = t.${siteCol}
      WHERE ${whereParts.join(' AND ')}
    `);
  };

  // Reset params for each call — we'll use a simpler approach
  params.length = 0;

  // Build all sub-queries with shared param indices
  const whereParts = (siteCol = 'site_id') => {
    const parts = ["UPPER(COALESCE(t.cheque_status, '')) <> ''"];
    if (site_id) parts.push(`t.${siteCol} = $1`);
    if (statusFilter) parts.push(`UPPER(COALESCE(t.cheque_status, '')) = $${site_id ? 2 : 1}`);
    return parts.join(' AND ');
  };

  const allParams = [];
  if (site_id) allParams.push(parseInt(site_id));
  if (statusFilter) allParams.push(statusFilter);

  const unionParts = [
    `SELECT t.id, 'farmer_payment' AS source, COALESCE(t.particular, '') || ' - ' || COALESCE(f.name, '') AS entry_label,
      COALESCE(t.amount, 0)::numeric AS amount, t.cheque_no, t.cheque_status, t.date,
      f.site_id, s.name AS site_name, t.created_at,
      NULL::text AS plot_no, NULL::text AS booked_by
    FROM farmer_payments t
    LEFT JOIN farmers f ON f.id = t.farmer_id
    LEFT JOIN sites s ON s.id = f.site_id
    WHERE UPPER(COALESCE(t.cheque_status, '')) <> ''${site_id ? ` AND f.site_id = $1` : ''}${statusFilter ? ` AND UPPER(COALESCE(t.cheque_status, '')) = $${site_id ? 2 : 1}` : ''}`,

    `SELECT t.id, 'plot_commission_payment' AS source, 'Commission Payment #' || t.id AS entry_label,
      COALESCE(t.amount, 0)::numeric AS amount, t.cheque_no, t.cheque_status, t.date,
      pc.site_id, s.name AS site_name, t.created_at,
      NULL::text AS plot_no, NULL::text AS booked_by
    FROM plot_commission_payments t
    LEFT JOIN plot_commissions_v2 pc ON pc.id = t.plot_commission_id
    LEFT JOIN sites s ON s.id = pc.site_id
    WHERE UPPER(COALESCE(t.cheque_status, '')) <> ''${site_id ? ` AND pc.site_id = $1` : ''}${statusFilter ? ` AND UPPER(COALESCE(t.cheque_status, '')) = $${site_id ? 2 : 1}` : ''}`,

    `SELECT t.id, 'firm_transaction' AS source, COALESCE(t.description, '') || CASE WHEN t.name IS NOT NULL THEN ' - ' || t.name ELSE '' END AS entry_label,
      COALESCE(GREATEST(t.debit, t.credit), 0)::numeric AS amount, t.cheque_no, t.cheque_status, t.date,
      t.site_id, s.name AS site_name, t.created_at,
      NULL::text AS plot_no, NULL::text AS booked_by
    FROM firm_transactions t
    LEFT JOIN sites s ON s.id = t.site_id
    WHERE ${whereParts()}`,

    `SELECT t.id, 'plot_payment' AS source, 'Plot Payment - ' || COALESCE(p.plot_no, '') || ' ' || COALESCE(p.buyer_name, '') AS entry_label,
      COALESCE(t.amount, 0)::numeric AS amount, t.cheque_no, t.cheque_status, t.date,
      t.site_id, s.name AS site_name, t.created_at,
      p.plot_no, t.booked_by
    FROM plot_payments t
    LEFT JOIN sites s ON s.id = t.site_id
    LEFT JOIN plots p ON p.id = t.plot_id
    WHERE ${whereParts()}`,

    `SELECT t.id, 'plot_installment_payment' AS source, 'Plot Installment - ' || COALESCE(p.plot_no, '') AS entry_label,
      COALESCE(t.amount, 0)::numeric AS amount, t.cheque_no, t.cheque_status, t.payment_date AS date,
      p.site_id, s.name AS site_name, t.created_at,
      p.plot_no, NULL::text AS booked_by
    FROM plot_installment_payments t
    LEFT JOIN plots p ON p.id = t.plot_id
    LEFT JOIN sites s ON s.id = p.site_id
    WHERE UPPER(COALESCE(t.cheque_status, '')) <> ''${site_id ? ` AND p.site_id = $1` : ''}${statusFilter ? ` AND UPPER(COALESCE(t.cheque_status, '')) = $${site_id ? 2 : 1}` : ''}`,

    `SELECT t.id, 'expense' AS source, COALESCE(t.remark, t.category, '') AS entry_label,
      COALESCE(GREATEST(t.debit, t.credit), 0)::numeric AS amount, t.cheque_no, t.cheque_status, t.date,
      t.site_id, s.name AS site_name, t.created_at,
      NULL::text AS plot_no, NULL::text AS booked_by
    FROM expenses t
    LEFT JOIN sites s ON s.id = t.site_id
    WHERE ${whereParts()}`,

    `SELECT t.id, 'vendor_payment' AS source, 'Vendor - ' || COALESCE(vc.vendor_name, '') AS entry_label,
      COALESCE(t.amount, 0)::numeric AS amount, t.cheque_no, t.cheque_status, t.payment_date AS date,
      t.site_id, s.name AS site_name, t.created_at,
      NULL::text AS plot_no, NULL::text AS booked_by
    FROM vendor_payments t
    LEFT JOIN sites s ON s.id = t.site_id
    LEFT JOIN vendor_commitments vc ON vc.id = t.commitment_id
    WHERE ${whereParts()}`,

    ...(inventorySupportsChequeStatus ? [`SELECT t.id, 'vendor_inventory_payment' AS source, 'Inventory - ' || COALESCE(vio.item_name, '') AS entry_label,
      COALESCE(t.amount, 0)::numeric AS amount, t.cheque_no, t.cheque_status, t.payment_date AS date,
      t.site_id, s.name AS site_name, t.created_at,
      NULL::text AS plot_no, NULL::text AS booked_by
    FROM vendor_inventory_payments t
    LEFT JOIN sites s ON s.id = t.site_id
    LEFT JOIN vendor_inventory_orders vio ON vio.id = t.order_id
    WHERE ${whereParts()}${inventorySourceFilter}`] : []),

    `SELECT t.id, 'cash_flow_entry' AS source, COALESCE(t.particular, '') AS entry_label,
      COALESCE(GREATEST(t.debit, t.credit), 0)::numeric AS amount, t.cheque_no, t.cheque_status, t.date,
      t.site_id, s.name AS site_name, t.created_at,
      NULL::text AS plot_no, NULL::text AS booked_by
    FROM cash_flow_entries t
    LEFT JOIN sites s ON s.id = t.site_id
    WHERE ${whereParts()} AND t.source_module IS NULL`,

    `SELECT t.id, 'plot_registry_payment' AS source, 'Registry Payment #' || t.id AS entry_label,
      COALESCE(t.amount, 0)::numeric AS amount, t.cheque_no, t.cheque_status, t.payment_date AS date,
      r.site_id, s.name AS site_name, t.created_at,
      NULL::text AS plot_no, NULL::text AS booked_by
    FROM plot_registry_payments t
    LEFT JOIN plot_registries r ON r.id = t.registry_id
    LEFT JOIN sites s ON s.id = r.site_id
    WHERE UPPER(COALESCE(t.cheque_status, '')) <> ''${site_id ? ` AND r.site_id = $1` : ''}${statusFilter ? ` AND UPPER(COALESCE(t.cheque_status, '')) = $${site_id ? 2 : 1}` : ''}`,

    `SELECT t.id, 'land_deal_payment' AS source, 'Land Sale - ' || COALESCE(d.buyer_name, '') AS entry_label,
      COALESCE(t.amount, 0)::numeric AS amount, t.cheque_no, t.cheque_status, t.date,
      t.site_id, s.name AS site_name, t.created_at,
      NULL::text AS plot_no, NULL::text AS booked_by
    FROM land_deal_payments t
    LEFT JOIN land_deals d ON d.id = t.land_deal_id
    LEFT JOIN sites s ON s.id = t.site_id
    WHERE ${whereParts()}`,

    `SELECT t.id, 'misc_income_entry' AS source, 'Misc Income - ' || COALESCE(c.name, '') || COALESCE(' - ' || t.party_name, '') AS entry_label,
      COALESCE(t.amount, 0)::numeric AS amount, t.cheque_no, t.cheque_status, t.date,
      t.site_id, s.name AS site_name, t.created_at,
      NULL::text AS plot_no, NULL::text AS booked_by
    FROM misc_income_entries t
    LEFT JOIN misc_income_categories c ON c.id = t.category_id
    LEFT JOIN sites s ON s.id = t.site_id
    WHERE ${whereParts()}`,

    `SELECT t.id, 'daybook' AS source, COALESCE(t.particular, '') AS entry_label,
      COALESCE(GREATEST(t.debit, t.credit), 0)::numeric AS amount, t.cheque_no, t.cheque_status, t.date,
      t.site_id, s.name AS site_name, t.created_at,
      NULL::text AS plot_no, NULL::text AS booked_by
    FROM day_book t
    LEFT JOIN sites s ON s.id = t.site_id
    WHERE ${whereParts()} AND t.farmer_payment_id IS NULL AND t.commission_id IS NULL AND t.cash_flow_entry_id IS NULL AND t.firm_transaction_id IS NULL AND t.plot_payment_id IS NULL AND t.vendor_payment_id IS NULL`,
  ];

  const fullQuery = unionParts.join('\nUNION ALL\n') + '\nORDER BY created_at DESC';

  const result = await pool.query(fullQuery, allParams);

  // Count by status
  const statusCounts = { PENDING: 0, CLEARED: 0, BOUNCED: 0, RETURNED: 0 };
  result.rows.forEach(r => {
    const normalizedStatus = String(r.cheque_status || '').toUpperCase();
    if (statusCounts[normalizedStatus] !== undefined) statusCounts[normalizedStatus]++;
  });

  res.json({ entries: result.rows, counts: statusCounts, total: result.rows.length });
});

/**
 * PATCH /approvals/cheque-status
 * Update cheque_status for a payment entry (admin only).
 * Body: { id, source, cheque_status }
 * Valid cheque_status values: PENDING, CLEARED, BOUNCED, RETURNED
 */
export const updateChequeStatus = asyncHandler(async (req, res) => {
  // Preserve the original accounting debit/credit values. The shared command
  // changes cheque metadata only; ledger views exclude bounced/returned rows.
  const { id, source, cheque_status, cheque_no } = req.body;

  if (!id || !source || !cheque_status) {
    return res.status(400).json({ message: 'id, source, and cheque_status are required' });
  }

  const normalizedStatus = String(cheque_status).toUpperCase();
  if (!CHEQUE_STATUSES.includes(normalizedStatus)) {
    return res.status(400).json({ message: `cheque_status must be one of: ${CHEQUE_STATUSES.join(', ')}` });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await updateChequeStatusRecord(client, {
      source,
      entryId: id,
      status: normalizedStatus,
      chequeNo: cheque_no,
    });
    await client.query('COMMIT');
    res.json({ entry: result.after, message: `Cheque status updated to ${normalizedStatus}` });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
});
