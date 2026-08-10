import pool from '../config/db.js';
import asyncHandler from '../utils/asyncHandler.js';

/**
 * Bank Accounts (migration 089) — a configurable list of the firm's real bank
 * accounts, mappable to any non-cash money entry. The mapping lives on the
 * entry's `cash_flow_entries` mirror row (bank_account_id), so it works for
 * every module through one endpoint and never creates a row — no total can
 * double-count.
 */

// Whitelist: entry identity → the cash_flow_entries mirror row.
// 'cashflow_entry' targets a hand-written Personal Ledger row by its own id;
// everything else targets (source_module, source_id).
const MAP_SOURCES = new Set([
  'day_book', 'expenses', 'farmer_payments', 'plot_commissions',
  'firm_transactions', 'plot_payments', 'plot_installment_payments',
  'vendor_payments', 'plot_commission_payments', 'cashflow_entry',
]);

export const listBankAccounts = asyncHandler(async (req, res) => {
  const { site_id } = req.query;
  // Per-bank usage figures come from ledger_entries — same policy (approved,
  // not bounced, sane dates) as every other balance in the app.
  const params = [];
  let siteFilter = '';
  if (site_id) {
    params.push(parseInt(site_id));
    siteFilter = `AND le.site_id = $${params.length}`;
  }
  const { rows } = await pool.query(
    `SELECT ba.*,
            COALESCE(le.entries, 0)::int      AS entries,
            COALESCE(le.total_debit, 0)::numeric  AS total_debit,
            COALESCE(le.total_credit, 0)::numeric AS total_credit
       FROM bank_accounts ba
       LEFT JOIN LATERAL (
         SELECT COUNT(*) AS entries, SUM(le.debit) AS total_debit, SUM(le.credit) AS total_credit
           FROM ledger_entries le
          WHERE le.bank_account_id = ba.id ${siteFilter}
       ) le ON TRUE
      ORDER BY ba.is_active DESC, ba.name ASC`,
    params
  );
  res.json({ banks: rows });
});

export const createBankAccount = asyncHandler(async (req, res) => {
  const { name, account_no, ifsc, branch, account_holder, notes, is_active } = req.body;
  if (!name || !String(name).trim()) return res.status(400).json({ message: 'Bank name is required' });
  try {
    const { rows } = await pool.query(
      `INSERT INTO bank_accounts (name, account_no, ifsc, branch, account_holder, notes, is_active, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, TRUE), $8)
       RETURNING *`,
      [String(name).trim().toUpperCase(), account_no || null, ifsc || null, branch || null,
       account_holder || null, notes || null, is_active, req.user?.id || null]
    );
    res.status(201).json({ bank: rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ message: 'A bank account with this name already exists' });
    throw err;
  }
});

export const updateBankAccount = asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id);
  const { name, account_no, ifsc, branch, account_holder, notes, is_active } = req.body;
  if (name !== undefined && !String(name).trim()) return res.status(400).json({ message: 'Bank name cannot be empty' });
  try {
    const { rows } = await pool.query(
      `UPDATE bank_accounts SET
         name = COALESCE($2, name),
         account_no = COALESCE($3, account_no),
         ifsc = COALESCE($4, ifsc),
         branch = COALESCE($5, branch),
         account_holder = COALESCE($6, account_holder),
         notes = COALESCE($7, notes),
         is_active = COALESCE($8, is_active),
         updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [id, name ? String(name).trim().toUpperCase() : null, account_no, ifsc, branch, account_holder, notes, is_active]
    );
    if (!rows.length) return res.status(404).json({ message: 'Bank account not found' });
    res.json({ bank: rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ message: 'A bank account with this name already exists' });
    throw err;
  }
});

export const deleteBankAccount = asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id);
  // ON DELETE SET NULL on cash_flow_entries.bank_account_id — entries survive,
  // they just become unmapped. Report how many so the client can say so.
  const { rows: mapped } = await pool.query(
    'SELECT COUNT(*)::int AS n FROM cash_flow_entries WHERE bank_account_id = $1', [id]
  );
  const { rowCount } = await pool.query('DELETE FROM bank_accounts WHERE id = $1', [id]);
  if (!rowCount) return res.status(404).json({ message: 'Bank account not found' });
  res.json({ message: 'Bank account deleted', unmapped_entries: mapped[0].n });
});

// Current mapping of one entry — module edit-modals prefill from this.
export const getEntryBankMapping = asyncHandler(async (req, res) => {
  const { source_key, source_id } = req.query;
  const sid = parseInt(source_id);
  if (!MAP_SOURCES.has(source_key) || !sid) {
    return res.status(400).json({ message: 'Invalid entry reference' });
  }
  const { rows } = source_key === 'cashflow_entry'
    ? await pool.query(
        `SELECT cfe.bank_account_id, ba.name AS bank_account_name
           FROM cash_flow_entries cfe LEFT JOIN bank_accounts ba ON ba.id = cfe.bank_account_id
          WHERE cfe.id = $1 AND cfe.source_module IS NULL`, [sid])
    : await pool.query(
        `SELECT cfe.bank_account_id, ba.name AS bank_account_name
           FROM cash_flow_entries cfe LEFT JOIN bank_accounts ba ON ba.id = cfe.bank_account_id
          WHERE cfe.source_module = $1 AND cfe.source_id = $2`, [source_key, sid]);
  res.json({ bank_account_id: rows[0]?.bank_account_id ?? null, bank_account_name: rows[0]?.bank_account_name ?? null });
});

// Map (or unmap: bank_account_id = null) any money entry to a bank account.
export const mapEntryToBank = asyncHandler(async (req, res) => {
  const { source_key, source_id, bank_account_id } = req.body;
  const sid = parseInt(source_id);
  if (!MAP_SOURCES.has(source_key) || !sid) {
    return res.status(400).json({ message: 'Invalid entry reference' });
  }
  const bankId = bank_account_id == null ? null : parseInt(bank_account_id);
  if (bankId != null) {
    const { rows } = await pool.query('SELECT id FROM bank_accounts WHERE id = $1', [bankId]);
    if (!rows.length) return res.status(404).json({ message: 'Bank account not found' });
  }
  const result = source_key === 'cashflow_entry'
    ? await pool.query(
        `UPDATE cash_flow_entries SET bank_account_id = $1, updated_at = NOW()
          WHERE id = $2 AND source_module IS NULL RETURNING id`,
        [bankId, sid]
      )
    : await pool.query(
        `UPDATE cash_flow_entries SET bank_account_id = $1, updated_at = NOW()
          WHERE source_module = $2 AND source_id = $3 RETURNING id`,
        [bankId, source_key, sid]
      );
  if (!result.rowCount) return res.status(404).json({ message: 'Ledger row not found for this entry' });
  res.json({ message: bankId == null ? 'Bank unmapped' : 'Entry mapped to bank', ledger_id: result.rows[0].id });
});

// All ledger entries of one bank (the drill-in page). Cross-site by default —
// a bank account is firm-level — with optional site/date narrowing.
export const listBankEntries = asyncHandler(async (req, res) => {
  const bankId = parseInt(req.params.id);
  const { site_id, date_from, date_to, limit } = req.query;
  const { rows: bankRows } = await pool.query('SELECT * FROM bank_accounts WHERE id = $1', [bankId]);
  if (!bankRows.length) return res.status(404).json({ message: 'Bank account not found' });

  const params = [bankId];
  const where = ['le.bank_account_id = $1'];
  if (site_id) { params.push(parseInt(site_id)); where.push(`le.site_id = $${params.length}`); }
  if (date_from) { params.push(date_from); where.push(`le.entry_date >= $${params.length}::date`); }
  if (date_to) { params.push(date_to); where.push(`le.entry_date <= $${params.length}::date`); }
  params.push(Math.min(parseInt(limit) || 1000, 5000));

  const { rows } = await pool.query(
    `SELECT le.*, TO_CHAR(le.entry_date, 'YYYY-MM-DD') AS entry_date, s.name AS site_name
       FROM ledger_entries le
       LEFT JOIN sites s ON s.id = le.site_id
      WHERE ${where.join(' AND ')}
      ORDER BY le.entry_date DESC, le.created_at DESC
      LIMIT $${params.length}`,
    params
  );
  let total_debit = 0, total_credit = 0;
  for (const r of rows) { total_debit += parseFloat(r.debit) || 0; total_credit += parseFloat(r.credit) || 0; }
  res.json({
    bank: bankRows[0],
    entries: rows,
    summary: { entries: rows.length, total_debit, total_credit, net: total_credit - total_debit },
  });
});

// Non-cash ledger entries not yet mapped to any bank — so mapping can also be
// driven from the Bank Accounts page, not only from the Day Book rows.
export const listUnmappedEntries = asyncHandler(async (req, res) => {
  const { site_id, date_from, date_to, q, limit } = req.query;
  const params = [];
  const where = [`le.bucket <> 'cash'`, 'le.bank_account_id IS NULL'];
  if (site_id) { params.push(parseInt(site_id)); where.push(`le.site_id = $${params.length}`); }
  if (date_from) { params.push(date_from); where.push(`le.entry_date >= $${params.length}::date`); }
  if (date_to) { params.push(date_to); where.push(`le.entry_date <= $${params.length}::date`); }
  if (q) {
    params.push(`%${q}%`);
    where.push(`(le.particular ILIKE $${params.length} OR COALESCE(le.entity_name, '') ILIKE $${params.length})`);
  }
  params.push(Math.min(parseInt(limit) || 200, 2000));
  const { rows } = await pool.query(
    `SELECT le.*, TO_CHAR(le.entry_date, 'YYYY-MM-DD') AS entry_date, s.name AS site_name
       FROM ledger_entries le
       LEFT JOIN sites s ON s.id = le.site_id
      WHERE ${where.join(' AND ')}
      ORDER BY le.entry_date DESC, le.created_at DESC
      LIMIT $${params.length}`,
    params
  );
  res.json({ entries: rows });
});
