import asyncHandler from '../utils/asyncHandler.js';
import balanceSheetModel from '../models/BalanceSheet.model.js';
import pool from '../config/db.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const VALID_SCOPES = new Set(['all', 'cash', 'bank']);
const VALID_DIRECTIONS = new Set(['all', 'credit', 'debit']);
// Buckets are cash/bank, but `raw_mode` keeps the mode the user actually
// picked (CHEQUE, UPI, IMPS, NEFT, RTGS…). The model matches either, so any
// of them is a legal filter value — don't whitelist to the two buckets or
// filtering by IMPS silently falls back to "all".
const MODE_RE = /^[a-z ]{2,20}$/;

const isoDate = (date) => {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
};

const presetRange = (preset) => {
  const today = new Date();
  const from = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const to = new Date(from);

  if (preset === 'today') return { dateFrom: isoDate(from), dateTo: isoDate(to) };
  if (preset === 'week') {
    const day = from.getDay() || 7;
    from.setDate(from.getDate() - day + 1);
    return { dateFrom: isoDate(from), dateTo: isoDate(to) };
  }
  if (preset === 'month') {
    from.setDate(1);
    return { dateFrom: isoDate(from), dateTo: isoDate(to) };
  }
  if (preset === 'year') {
    from.setMonth(0, 1);
    return { dateFrom: isoDate(from), dateTo: isoDate(to) };
  }
  return { dateFrom: null, dateTo: null };
};

export const getBalanceSheet = asyncHandler(async (req, res) => {
  const siteId = Number.parseInt(req.query.site_id, 10);
  if (!Number.isInteger(siteId) || siteId <= 0) {
    return res.status(400).json({ message: 'A valid site_id is required' });
  }

  const scope = VALID_SCOPES.has(req.query.scope) ? req.query.scope : 'all';
  const direction = VALID_DIRECTIONS.has(req.query.direction) ? req.query.direction : 'all';
  const rawMode = String(req.query.payment_mode || 'all').trim().toLowerCase();
  const paymentMode = rawMode === 'all' || MODE_RE.test(rawMode) ? rawMode : 'all';
  const source = String(req.query.source || 'all').trim().slice(0, 80) || 'all';
  const search = String(req.query.q || '').trim().slice(0, 120);
  const preset = String(req.query.preset || 'overall').toLowerCase();

  let { dateFrom, dateTo } = presetRange(preset);
  if (req.query.date) {
    if (!DATE_RE.test(req.query.date)) return res.status(400).json({ message: 'date must be YYYY-MM-DD' });
    dateFrom = req.query.date;
    dateTo = req.query.date;
  }
  if (req.query.date_from || req.query.date_to) {
    dateFrom = req.query.date_from || null;
    dateTo = req.query.date_to || null;
    if ((dateFrom && !DATE_RE.test(dateFrom)) || (dateTo && !DATE_RE.test(dateTo))) {
      return res.status(400).json({ message: 'date_from and date_to must be YYYY-MM-DD' });
    }
  }
  if (dateFrom && dateTo && dateFrom > dateTo) {
    return res.status(400).json({ message: 'date_from cannot be after date_to' });
  }

  // Statements are also used by Day Book's Overall print and Excel exports.
  // Keep a generous safety ceiling while allowing those exports to include all
  // normal accounting history rather than a truncated on-screen subset.
  const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 2500, 1), 100000);
  const rangeDays = dateFrom && dateTo
    ? Math.ceil((new Date(`${dateTo}T00:00:00`) - new Date(`${dateFrom}T00:00:00`)) / 86400000) + 1
    : null;
  const grain = rangeDays !== null && rangeDays <= 62 ? 'day' : 'month';

  const [siteResult, report] = await Promise.all([
    pool.query('SELECT id, name, code, address, city, state FROM sites WHERE id = $1', [siteId]),
    balanceSheetModel.getReport({
      siteId,
      dateFrom,
      dateTo,
      scope,
      source,
      paymentMode,
      direction,
      search,
      limit,
      grain,
    }),
  ]);

  const site = siteResult.rows[0];
  if (!site) return res.status(404).json({ message: 'Site not found' });

  res.json({
    site,
    scope,
    period: { preset, date_from: dateFrom, date_to: dateTo, grain },
    filters: { source, payment_mode: paymentMode, direction, q: search },
    ...report,
  });
});
