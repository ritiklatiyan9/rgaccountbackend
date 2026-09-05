import { transactionTimeForWrite } from '../services/transactionTime.service.js';
// Miscellaneous Income — maintenance charges, token money, gifts, rent, interest…
// Entries are CREDIT (money in) or DEBIT (a refund against that income). They mirror into
// the ledger through the migration-110 trigger, so every total here is what `ledger_entries`
// sees under the shared posting policy. Categories are user-managed and global across sites.
import asyncHandler from '../utils/asyncHandler.js';
import pool from '../config/db.js';
import { resolveEntryVisibility } from '../services/entryVisibility.service.js';
import { transactionMovesMoney } from '../utils/transactionPosting.js';

const ADMIN_ROLES = new Set(['admin', 'super_admin']);
const PAYMENT_MODES = new Set(['CASH', 'BANK', 'CHEQUE', 'UPI', 'NEFT', 'RTGS', 'IMPS', 'TRANSFER']);
const DIRECTIONS = new Set(['credit', 'debit']);
const HEX_COLOR = /^#[0-9a-f]{6}$/i;

const num = (v) => Number(v) || 0;
const money = (v) => Math.round(num(v) * 100) / 100;
const optionalNumber = (v) => {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const isoDate = (v) => {
  if (!v) return null;
  const s = String(v).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
};

/** Site gate: admins bypass, everyone else must hold the site. Responds and returns null on failure. */
const gateSite = async (req, res, siteId) => {
  if (!Number.isInteger(siteId) || siteId <= 0) { res.status(400).json({ message: 'site_id is required' }); return false; }
  if (ADMIN_ROLES.has(req.user.role)) return true;
  const { rows } = await pool.query('SELECT 1 FROM user_sites WHERE user_id = $1 AND site_id = $2 LIMIT 1', [req.user.id, siteId]);
  if (!rows[0]) { res.status(403).json({ message: 'Access denied to this site' }); return false; }
  return true;
};

/* ── Categories ─────────────────────────────────────────────────────────── */

export const listCategories = asyncHandler(async (_req, res) => {
  const { rows } = await pool.query(
    `SELECT c.id, c.name, c.color, c.is_active, c.created_at,
            COUNT(e.id)::int AS entry_count
       FROM misc_income_categories c
       LEFT JOIN misc_income_entries e ON e.category_id = c.id
      GROUP BY c.id
      ORDER BY c.is_active DESC, LOWER(c.name)`,
  );
  res.json({ categories: rows });
});

const categoryPayload = (body, existing = {}) => {
  const name = body.name === undefined ? existing.name : String(body.name || '').trim().slice(0, 100);
  const color = body.color === undefined ? existing.color ?? null : (HEX_COLOR.test(String(body.color || '')) ? String(body.color).toLowerCase() : null);
  const is_active = body.is_active === undefined ? existing.is_active ?? true : Boolean(body.is_active);
  return { name, color, is_active };
};

export const createCategory = asyncHandler(async (req, res) => {
  const data = categoryPayload(req.body);
  if (!data.name) return res.status(400).json({ message: 'Category name is required' });
  try {
    const { rows } = await pool.query(
      `INSERT INTO misc_income_categories (name, color, is_active, created_by)
       VALUES ($1, $2, TRUE, $3)
       RETURNING id, name, color, is_active, created_at, 0 AS entry_count`,
      [data.name, data.color, req.user.id],
    );
    res.status(201).json({ category: rows[0], message: 'Category created' });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ message: `A category named "${data.name}" already exists` });
    throw err;
  }
});

export const updateCategory = asyncHandler(async (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  const { rows: found } = await pool.query('SELECT * FROM misc_income_categories WHERE id = $1', [id]);
  if (!found[0]) return res.status(404).json({ message: 'Category not found' });
  const data = categoryPayload(req.body, found[0]);
  if (!data.name) return res.status(400).json({ message: 'Category name is required' });
  try {
    const { rows } = await pool.query(
      `UPDATE misc_income_categories SET name = $2, color = $3, is_active = $4, updated_at = NOW()
        WHERE id = $1
        RETURNING id, name, color, is_active, created_at,
                  (SELECT COUNT(*)::int FROM misc_income_entries e WHERE e.category_id = $1) AS entry_count`,
      [id, data.name, data.color, data.is_active],
    );
    res.json({ category: rows[0], message: 'Category updated' });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ message: `A category named "${data.name}" already exists` });
    throw err;
  }
});

/** A category with entries is deactivated (the FK is RESTRICT and history must keep its label). */
export const deleteCategory = asyncHandler(async (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  const { rows } = await pool.query(
    `SELECT c.id, (SELECT COUNT(*)::int FROM misc_income_entries e WHERE e.category_id = c.id) AS entry_count
       FROM misc_income_categories c WHERE c.id = $1`, [id]);
  if (!rows[0]) return res.status(404).json({ message: 'Category not found' });
  if (rows[0].entry_count > 0) {
    await pool.query('UPDATE misc_income_categories SET is_active = FALSE, updated_at = NOW() WHERE id = $1', [id]);
    return res.json({ message: `Category has ${rows[0].entry_count} entries, so it was deactivated instead of deleted`, deactivated: true });
  }
  await pool.query('DELETE FROM misc_income_categories WHERE id = $1', [id]);
  res.json({ message: 'Category deleted', deactivated: false });
});

/* ── Entries ────────────────────────────────────────────────────────────── */

const ENTRY_SELECT = `
  SELECT e.*, c.name AS category_name, c.color AS category_color,
         u.name AS created_by_name, a.name AS approved_by_name, aa.name AS assigned_admin_name
    FROM misc_income_entries e
    JOIN misc_income_categories c ON c.id = e.category_id
    LEFT JOIN users u ON u.id = e.created_by
    LEFT JOIN users a ON a.id = e.approved_by
    LEFT JOIN users aa ON aa.id = e.assigned_admin_id`;

const summarise = (rows) => {
  const byCat = new Map();
  const s = { credit: 0, debit: 0, net: 0, count: rows.length, pending_amount: 0, by_category: [] };
  for (const r of rows) {
    const amt = num(r.amount);
    const active = transactionMovesMoney({
      direction: r.direction,
      status: r.status,
      paymentMode: r.payment_mode,
      chequeStatus: r.cheque_status,
    });
    if (String(r.status || '').toLowerCase() === 'pending') s.pending_amount += amt;
    const cat = byCat.get(r.category_id) || { category_id: r.category_id, category_name: r.category_name, category_color: r.category_color, credit: 0, debit: 0, net: 0, count: 0 };
    cat.count += 1;
    if (active) {
      if (r.direction === 'debit') { s.debit += amt; cat.debit += amt; } else { s.credit += amt; cat.credit += amt; }
    }
    byCat.set(r.category_id, cat);
  }
  s.net = money(s.credit - s.debit);
  s.credit = money(s.credit); s.debit = money(s.debit); s.pending_amount = money(s.pending_amount);
  s.by_category = [...byCat.values()].map((c) => ({ ...c, credit: money(c.credit), debit: money(c.debit), net: money(c.credit - c.debit) }))
    .sort((a, b) => b.net - a.net || a.category_name.localeCompare(b.category_name));
  return s;
};

/** GET /misc-income?site_id=&from=&to=&category_id=&direction= → { entries, summary } */
export const listEntries = asyncHandler(async (req, res) => {
  const siteId = Number.parseInt(req.query.site_id, 10);
  if (!(await gateSite(req, res, siteId))) return;
  const visibility = await resolveEntryVisibility(req.user, 'misc_income', req.query.created_by);
  const from = isoDate(req.query.from);
  const to = isoDate(req.query.to);
  const categoryId = optionalNumber(req.query.category_id);
  const direction = DIRECTIONS.has(req.query.direction) ? req.query.direction : null;

  const { rows } = await pool.query(
    `${ENTRY_SELECT}
      WHERE e.site_id = $1
        AND ($2::date IS NULL OR e.date >= $2::date)
        AND ($3::date IS NULL OR e.date <= $3::date)
        AND ($4::int IS NULL OR e.category_id = $4::int)
        AND ($5::text IS NULL OR e.direction = $5::text)
        AND ($6::int IS NULL OR e.created_by = $6::int)
      ORDER BY e.date DESC, e.id DESC`,
    [siteId, from, to, categoryId, direction, visibility.creatorId],
  );
  res.json({ entries: rows, summary: summarise(rows), entryVisibility: visibility });
});

const entryPayload = (body, existing = {}) => {
  const merged = { ...existing, ...body };
  const mode = String(merged.payment_mode || 'CASH').toUpperCase();
  return {
    category_id: optionalNumber(merged.category_id),
    direction: DIRECTIONS.has(merged.direction) ? merged.direction : 'credit',
    date: isoDate(merged.date) || new Date().toLocaleDateString('en-CA'),
    amount: num(merged.amount),
    payment_mode: PAYMENT_MODES.has(mode) ? mode : 'CASH',
    party_name: merged.party_name ? String(merged.party_name).trim().toUpperCase().slice(0, 255) : null,
    bank_name: merged.bank_name ? String(merged.bank_name).trim().toUpperCase() : null,
    bank_account_no: merged.bank_account_no ? String(merged.bank_account_no).trim() : null,
    bank_reference: merged.bank_reference ? String(merged.bank_reference).trim() : null,
    bank_ifsc: merged.bank_ifsc ? String(merged.bank_ifsc).trim().toUpperCase() : null,
    cheque_no: merged.cheque_no ? String(merged.cheque_no).trim() : null,
    remarks: merged.remarks ? String(merged.remarks).trim() : null,
    voucher_url: merged.voucher_url || null,
    assigned_admin_id: optionalNumber(merged.assigned_admin_id),
  };
};

const validateEntry = async (data, res) => {
  if (!(data.amount > 0)) { res.status(400).json({ message: 'Amount must be greater than zero' }); return false; }
  if (!data.category_id) { res.status(400).json({ message: 'Category is required' }); return false; }
  const { rows } = await pool.query('SELECT is_active FROM misc_income_categories WHERE id = $1', [data.category_id]);
  if (!rows[0]) { res.status(400).json({ message: 'Category not found' }); return false; }
  if (!rows[0].is_active) { res.status(400).json({ message: 'That category is inactive — reactivate it or pick another' }); return false; }
  return true;
};

const loadEntry = async (id) => (await pool.query(`${ENTRY_SELECT} WHERE e.id = $1`, [id])).rows[0] || null;

/** POST /misc-income — always created pending, like every other money module. */
export const createEntry = asyncHandler(async (req, res) => {
  const siteId = Number.parseInt(req.body.site_id, 10);
  if (!(await gateSite(req, res, siteId))) return;
  const data = entryPayload(req.body);
  if (!(await validateEntry(data, res))) return;

  const { rows } = await pool.query(
    `INSERT INTO misc_income_entries (
       site_id, category_id, direction, date, amount, payment_mode, party_name,
       bank_name, bank_account_no, bank_reference, bank_ifsc, cheque_no, cheque_status,
       remarks, voucher_url, status, assigned_admin_id, created_by, transaction_time
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'pending',$16,$17,$18::time)
     RETURNING id`,
    [siteId, data.category_id, data.direction, data.date, data.amount, data.payment_mode, data.party_name,
      data.bank_name, data.bank_account_no, data.bank_reference, data.bank_ifsc, data.cheque_no,
      data.payment_mode === 'CHEQUE' ? 'PENDING' : null, data.remarks, data.voucher_url,
      data.assigned_admin_id, req.user.id, transactionTimeForWrite()],
  );
  res.status(201).json({ entry: await loadEntry(rows[0].id), message: `${data.direction === 'debit' ? 'Debit' : 'Credit'} recorded and is pending approval` });
});

/** PUT /misc-income/:id — edits return the row to pending approval. */
export const updateEntry = asyncHandler(async (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  const existing = await loadEntry(id);
  if (!existing) return res.status(404).json({ message: 'Entry not found' });
  if (!(await gateSite(req, res, existing.site_id))) return;
  const data = entryPayload(req.body, existing);
  if (!(await validateEntry(data, res))) return;

  await pool.query(
    `UPDATE misc_income_entries SET
       category_id=$2, direction=$3, date=$4, amount=$5, payment_mode=$6, party_name=$7,
       bank_name=$8, bank_account_no=$9, bank_reference=$10, bank_ifsc=$11, cheque_no=$12, cheque_status=$13,
       remarks=$14, voucher_url=$15, assigned_admin_id=$16, transaction_time=$17::time,
       status='pending', approved_by=NULL, approved_at=NULL, updated_at=NOW()
     WHERE id=$1`,
    [id, data.category_id, data.direction, data.date, data.amount, data.payment_mode, data.party_name,
      data.bank_name, data.bank_account_no, data.bank_reference, data.bank_ifsc, data.cheque_no,
      data.payment_mode === 'CHEQUE' ? 'PENDING' : null, data.remarks, data.voucher_url, data.assigned_admin_id, transactionTimeForWrite(existing.transaction_time ?? null)],
  );
  res.json({ entry: await loadEntry(id), message: 'Entry updated and sent for approval' });
});

/** DELETE /misc-income/:id — the trigger removes the ledger mirror. */
export const deleteEntry = asyncHandler(async (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  const { rows } = await pool.query('SELECT site_id FROM misc_income_entries WHERE id = $1', [id]);
  if (!rows[0]) return res.status(404).json({ message: 'Entry not found' });
  if (!(await gateSite(req, res, rows[0].site_id))) return;
  await pool.query('DELETE FROM misc_income_entries WHERE id = $1', [id]);
  res.json({ message: 'Entry deleted' });
});
