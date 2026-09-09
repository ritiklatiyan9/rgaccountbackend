import { transactionTimeForWrite } from '../services/transactionTime.service.js';
// Land Sale + Land Profit — the SELL side of Lands Payments.
//
// Land Purchase is the `farmers` row (the land we bought: area, total_amount = what we
// owe the seller) with `farmer_payments` as the money out. A `land_deals` row is one
// SALE cut from that land (farmer_id is the mapping; one land can be sold in pieces) and
// `land_deal_payments` are the buyer's receipts — the only rows here that move money: a
// trigger mirrors them into cash_flow_entries as CREDITs (migration 109).
//
// `purchase_cost` on a sale is its share of the purchase price (by area when the land has
// one — src/utils/landMapping.js). It never posts to the ledger; the farmer payments
// already did. profit = sale_amount − purchase_cost − other_cost.
import asyncHandler from '../utils/asyncHandler.js';
import pool from '../config/db.js';
import { farmerModel } from '../models/Farmer.model.js';
import { resolveEntryVisibility } from '../services/entryVisibility.service.js';
import { allocateCost, landArea, landStage, landUnit, overSold, remainingArea, soldArea } from '../utils/landMapping.js';
import { landShareRows } from '../services/partnerShares.service.js';

const ADMIN_ROLES = new Set(['admin', 'super_admin']);
const GAZ_TO_SQ_METRE = 0.8364;
const DEAL_STATUSES = new Set(['open', 'completed', 'cancelled']);
const RATE_UNITS = new Set(['bigha', 'gaz', 'mtr']);
const PAYMENT_MODES = new Set(['CASH', 'BANK', 'CHEQUE', 'UPI', 'NEFT', 'RTGS', 'IMPS', 'TRANSFER']);

// Buyer receipts are credits, so they post while Pending. Cheques still wait for CLEARED.
const ACTIVE_PAYMENT = `financial_transaction_posts('credit', p.status, p.payment_mode, p.cheque_status)`;

const num = (v) => (Number(v) || 0);
const money = (v) => Math.round(num(v) * 100) / 100;
const pct = (part, whole) => (whole > 0 ? Math.round(Math.min(part / whole, 1) * 1000) / 10 : 0);
const optionalNumber = (value) => {
  if (value === '' || value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};
/** Area is entered in gaz OR square metres; store both, like the farmers module does. */
const normalizeArea = (gazValue, metreValue) => {
  const gaz = optionalNumber(gazValue);
  if (gaz !== null) return { area_gaz: Number(gaz.toFixed(4)), area_mtr: Number((gaz * GAZ_TO_SQ_METRE).toFixed(4)) };
  const metres = optionalNumber(metreValue);
  if (metres !== null) return { area_gaz: Number((metres / GAZ_TO_SQ_METRE).toFixed(4)), area_mtr: Number(metres.toFixed(4)) };
  return { area_gaz: null, area_mtr: null };
};

const siteAllowed = async (req, siteId) => {
  if (ADMIN_ROLES.has(req.user.role)) return true;
  const { rows } = await pool.query('SELECT 1 FROM user_sites WHERE user_id = $1 AND site_id = $2 LIMIT 1', [req.user.id, siteId]);
  return !!rows[0];
};
/** site_id from query or body + user_sites gate. Responds and returns null on failure. */
const resolveSite = async (req, res, source = 'query') => {
  const raw = source === 'body' ? req.body?.site_id : req.query?.site_id;
  const siteId = Number.parseInt(raw, 10);
  if (!Number.isInteger(siteId) || siteId <= 0) { res.status(400).json({ message: 'site_id is required' }); return null; }
  if (!(await siteAllowed(req, siteId))) { res.status(403).json({ message: 'Access denied to this site' }); return null; }
  return siteId;
};
const tx = async (fn) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
};

/* ── Sale rows ──────────────────────────────────────────────────────────── */

// One SELECT for the list and the single row: the sale, the land it maps to, and its receipts rollup.
const saleSql = (where, vis) => `
  SELECT d.*,
         f.name AS farmer_name, f.phone AS farmer_phone, f.total_amount AS farmer_total_amount,
         f.land_size_bigha AS farmer_land_bigha, f.land_size_gaz AS farmer_land_gaz, f.land_size_mtr AS farmer_land_mtr,
         u.name AS created_by_name,
         COALESCE(SUM(p.amount) FILTER (WHERE ${ACTIVE_PAYMENT}), 0)::numeric(15,2) AS received,
         COALESCE(SUM(p.amount) FILTER (WHERE ${ACTIVE_PAYMENT} AND ledger_bucket(p.payment_mode) = 'cash'), 0)::numeric(15,2) AS cash_received,
         COALESCE(SUM(p.amount) FILTER (WHERE ${ACTIVE_PAYMENT} AND ledger_bucket(p.payment_mode) <> 'cash'), 0)::numeric(15,2) AS bank_received,
         COALESCE(SUM(p.amount) FILTER (WHERE LOWER(COALESCE(p.status, 'approved')) = 'pending'), 0)::numeric(15,2) AS pending_amount,
         COUNT(p.id)::int AS payment_count,
         MAX(p.date) FILTER (WHERE ${ACTIVE_PAYMENT}) AS last_payment_date
    FROM land_deals d
    LEFT JOIN farmers f ON f.id = d.farmer_id
    LEFT JOIN users u ON u.id = d.created_by
    LEFT JOIN land_deal_payments p ON p.land_deal_id = d.id
         AND (${vis}::text IS NULL OR p.created_by = ANY(string_to_array(${vis}::text, ',')::int[]))
   WHERE ${where}
   GROUP BY d.id, f.id, u.id
   ORDER BY d.deal_date DESC, d.id DESC`;

/** profit = sale − cost share − other cost; stage = cancelled | collecting | collected. */
const withProfit = (row) => {
  const sale = num(row.sale_amount);
  const cost = num(row.purchase_cost);
  const other = num(row.other_cost);
  const received = num(row.received);
  const profit = sale - cost - other;
  const outstanding = Math.max(sale - received, 0);
  const stage = row.status === 'cancelled' ? 'cancelled'
    : row.status === 'completed' || (sale > 0 && outstanding < 0.005) ? 'collected' : 'collecting';
  return {
    ...row,
    stage,
    sale_amount: money(sale),
    purchase_cost: money(cost),
    other_cost: money(other),
    total_cost: money(cost + other),
    profit: money(profit),
    margin_pct: sale > 0 ? Math.round((profit / sale) * 1000) / 10 : 0,
    received: money(received),
    cash_received: money(row.cash_received),
    bank_received: money(row.bank_received),
    pending_amount: money(row.pending_amount),
    outstanding: money(outstanding),
    collected_pct: pct(received, sale),
  };
};

const loadDeal = async (dealId, creatorId = null) => {
  const { rows } = await pool.query(saleSql('d.id = $1', '$2'), [dealId, creatorId]);
  return rows[0] ? withProfit(rows[0]) : null;
};

const summarise = (sales) => sales.reduce((acc, s) => {
  acc.sales += 1;
  acc[s.stage] = (acc[s.stage] || 0) + 1;
  if (s.stage === 'cancelled') return acc;
  for (const k of ['sale_value', 'allocated_cost', 'other_cost', 'profit', 'received', 'outstanding', 'pending_amount', 'cash_received', 'bank_received']) {
    acc[k] = money(acc[k] + num(s[k === 'sale_value' ? 'sale_amount' : k === 'allocated_cost' ? 'purchase_cost' : k]));
  }
  return acc;
}, { sales: 0, collecting: 0, collected: 0, cancelled: 0, sale_value: 0, allocated_cost: 0, other_cost: 0, profit: 0,
  received: 0, outstanding: 0, pending_amount: 0, cash_received: 0, bank_received: 0 });

/** GET /land-deals?site_id=&status=&farmer_id= → { deals, summary } */
export const listDeals = asyncHandler(async (req, res) => {
  const siteId = await resolveSite(req, res);
  if (!siteId) return;
  const visibility = await resolveEntryVisibility(req.user, 'farmers', req.query.created_by);
  const status = DEAL_STATUSES.has(req.query.status) ? req.query.status : null;
  const farmerId = Number.parseInt(req.query.farmer_id, 10);
  const { rows } = await pool.query(
    saleSql('d.site_id = $1 AND ($2::text IS NULL OR d.status = $2::text) AND ($3::int IS NULL OR d.farmer_id = $3::int)', '$4'),
    [siteId, status, Number.isInteger(farmerId) ? farmerId : null, visibility.creatorId],
  );
  const deals = rows.map(withProfit);
  res.json({ deals, summary: summarise(deals), entryVisibility: visibility });
});

/** GET /land-deals/:id → { deal } */
export const getDeal = asyncHandler(async (req, res) => {
  const visibility = await resolveEntryVisibility(req.user, 'farmers', req.query.created_by);
  const deal = await loadDeal(Number.parseInt(req.params.id, 10), visibility.creatorId);
  if (!deal) return res.status(404).json({ message: 'Land sale not found' });
  if (!(await siteAllowed(req, deal.site_id))) return res.status(403).json({ message: 'Access denied to this site' });
  res.json({ deal });
});

/* ── Land Profit: every purchase with the sales mapped to it ──────────── */

const landOf = (farmer, sales) => {
  const liveSales = sales.filter((s) => s.stage !== 'cancelled');
  const sum = (key) => liveSales.reduce((acc, s) => acc + num(s[key]), 0);
  const total = num(farmer.total_amount);
  const paid = num(farmer.total_paid);
  const unit = landUnit(farmer);
  const saleValue = sum('sale_amount');
  const allocated = sum('purchase_cost');
  const other = sum('other_cost');
  const outstanding = sum('outstanding');
  const profit = saleValue - allocated - other;
  return {
    id: farmer.id, name: farmer.name, phone: farmer.phone, status: farmer.status, land_rate: farmer.land_rate,
    land_size_bigha: farmer.land_size_bigha, land_size_gaz: farmer.land_size_gaz, land_size_mtr: farmer.land_size_mtr,
    unit, area: landArea(farmer), sold_area: soldArea(farmer, sales), remaining_area: unit ? remainingArea(farmer, sales) : null,
    purchase_cost: money(total), paid_to_farmer: money(paid), farmer_pending: money(Math.max(total - paid, 0)), paid_pct: pct(paid, total),
    sales_count: liveSales.length, sale_value: money(saleValue), allocated_cost: money(allocated), stock_cost: money(Math.max(total - allocated, 0)),
    other_cost: money(other), profit: money(profit), margin_pct: saleValue > 0 ? Math.round((profit / saleValue) * 1000) / 10 : 0,
    received: money(sum('received')), outstanding: money(outstanding), pending_amount: money(sum('pending_amount')),
    cash_received: money(sum('cash_received')), bank_received: money(sum('bank_received')),
    stage: landStage(farmer, sales, paid), collecting: outstanding > 0.005,
    sales,
  };
};

/** GET /land-deals/profit?site_id= → { lands, summary } — one row per purchase, its sales nested. */
export const getLandProfit = asyncHandler(async (req, res) => {
  const siteId = await resolveSite(req, res);
  if (!siteId) return;
  const visibility = await resolveEntryVisibility(req.user, 'farmers', req.query.created_by);
  const [farmers, { rows }] = await Promise.all([
    farmerModel.findBySiteId(siteId, pool),
    pool.query(saleSql('d.site_id = $1', '$2'), [siteId, visibility.creatorId]),
  ]);
  const byFarmer = new Map();
  for (const row of rows) {
    const sale = withProfit(row);
    if (!byFarmer.has(sale.farmer_id)) byFarmer.set(sale.farmer_id, []);
    byFarmer.get(sale.farmer_id).push(sale);
  }
  const splits = await landShareRows(farmers.map((f) => f.id));
  const lands = farmers.map((f) => ({ ...landOf(f, byFarmer.get(f.id) || []), shares: splits.filter((s) => s.farmer_id === f.id) }));
  const summary = lands.reduce((acc, l) => {
    acc.lands += 1;
    acc[l.stage] = (acc[l.stage] || 0) + 1;
    if (l.collecting) acc.collecting += 1;
    for (const k of ['purchase_cost', 'paid_to_farmer', 'farmer_pending', 'sale_value', 'allocated_cost', 'stock_cost', 'other_cost', 'profit', 'received', 'outstanding', 'pending_amount', 'sales_count']) {
      acc[k] = money(acc[k] + l[k]);
    }
    return acc;
  }, { lands: 0, paying: 0, held: 0, partly_sold: 0, sold: 0, collecting: 0, purchase_cost: 0, paid_to_farmer: 0, farmer_pending: 0,
    sale_value: 0, allocated_cost: 0, stock_cost: 0, other_cost: 0, profit: 0, received: 0, outstanding: 0, pending_amount: 0, sales_count: 0 });
  res.json({ lands, summary, entryVisibility: visibility });
});

/* ── Create / update a sale ─────────────────────────────────────────────── */

const dealPayload = (body) => {
  const area = normalizeArea(body.area_gaz, body.area_mtr);
  return {
    farmer_id: optionalNumber(body.farmer_id),
    deal_no: body.deal_no ? String(body.deal_no).trim() : null,
    buyer_name: String(body.buyer_name || '').trim().toUpperCase(),
    buyer_member_id: optionalNumber(body.buyer_member_id),
    buyer_phone: body.buyer_phone ? String(body.buyer_phone).trim() : null,
    deal_date: body.deal_date || new Date().toLocaleDateString('en-CA'),
    area_bigha: optionalNumber(body.area_bigha),
    ...area,
    sale_rate: optionalNumber(body.sale_rate),
    rate_unit: RATE_UNITS.has(body.rate_unit) ? body.rate_unit : 'bigha',
    gaz_per_bigha: optionalNumber(body.gaz_per_bigha),
    sale_amount: Math.max(num(body.sale_amount), 0),
    purchase_cost: Math.max(num(body.purchase_cost), 0),
    other_cost: Math.max(num(body.other_cost), 0),
    notes: body.notes ? String(body.notes).trim() : null,
    status: DEAL_STATUSES.has(body.status) ? body.status : 'open',
  };
};

/** Locks the land, rejects an oversold piece, and fills the cost share when the caller left it blank. */
const mapToLand = async (client, siteId, data, excludeDealId = null) => {
  if (!data.farmer_id) return 'Map this sale to the land it was cut from';
  const { rows } = await client.query('SELECT * FROM farmers WHERE id = $1 FOR UPDATE', [data.farmer_id]);
  const farmer = rows[0];
  if (!farmer) return 'That land no longer exists in Land Purchase';
  if (Number(farmer.site_id) !== siteId) return 'That land belongs to another site';
  const { rows: others } = await client.query(
    'SELECT id, status, area_bigha, area_gaz, purchase_cost FROM land_deals WHERE farmer_id = $1 AND ($2::int IS NULL OR id <> $2::int)',
    [farmer.id, excludeDealId],
  );
  const message = overSold(farmer, others, data);
  if (message) return message;
  if (!(data.purchase_cost > 0)) data.purchase_cost = allocateCost(farmer, others, data);
  return null;
};

const validateDeal = (data) => {
  if (data.status === 'cancelled') return null;
  if (!data.buyer_name) return 'Buyer name is required';
  if (data.sale_amount <= 0) return 'Sale amount must be greater than zero';
  return null;
};

/** POST /land-deals → { deal } */
export const createDeal = asyncHandler(async (req, res) => {
  const siteId = await resolveSite(req, res, 'body');
  if (!siteId) return;
  const data = dealPayload(req.body);
  const invalid = validateDeal(data);
  if (invalid) return res.status(400).json({ message: invalid });

  const result = await tx(async (client) => {
    const error = await mapToLand(client, siteId, data);
    if (error) return { error };
    const { rows } = await client.query(
      `INSERT INTO land_deals (
         site_id, farmer_id, deal_no, buyer_name, buyer_member_id, buyer_phone, deal_date,
         area_bigha, area_gaz, area_mtr, sale_rate, sale_amount, purchase_cost, other_cost,
         notes, status, created_by, rate_unit, gaz_per_bigha, sold_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::text,$17,$18,$19,
                 CASE WHEN $16::text = 'cancelled' THEN NULL ELSE NOW() END)
       RETURNING id`,
      [siteId, data.farmer_id, data.deal_no, data.buyer_name || null, data.buyer_member_id, data.buyer_phone,
        data.deal_date, data.area_bigha, data.area_gaz, data.area_mtr, data.sale_rate, data.sale_amount,
        data.purchase_cost, data.other_cost, data.notes, data.status, req.user.id, data.rate_unit, data.gaz_per_bigha],
    );
    return { id: rows[0].id };
  });
  if (result.error) return res.status(400).json({ message: result.error });
  res.status(201).json({ deal: await loadDeal(result.id), message: 'Land sale recorded — add receipts as the buyer pays' });
});

/** PUT /land-deals/:id → { deal } — re-mapping to another land is allowed; the same checks apply. */
export const updateDeal = asyncHandler(async (req, res) => {
  const dealId = Number.parseInt(req.params.id, 10);
  const existing = await loadDeal(dealId);
  if (!existing) return res.status(404).json({ message: 'Land sale not found' });
  if (!(await siteAllowed(req, existing.site_id))) return res.status(403).json({ message: 'Access denied to this site' });
  const data = dealPayload({ ...existing, ...req.body });
  const invalid = validateDeal(data);
  if (invalid) return res.status(400).json({ message: invalid });

  const result = await tx(async (client) => {
    const error = await mapToLand(client, Number(existing.site_id), data, dealId);
    if (error) return { error };
    await client.query(
      `UPDATE land_deals SET
         farmer_id=$2, deal_no=$3, buyer_name=$4, buyer_member_id=$5, buyer_phone=$6, deal_date=$7,
         area_bigha=$8, area_gaz=$9, area_mtr=$10, sale_rate=$11, sale_amount=$12,
         purchase_cost=$13, other_cost=$14, notes=$15, status=$16::text, rate_unit=$17, gaz_per_bigha=$18,
         sold_at = CASE WHEN $16::text = 'cancelled' THEN NULL ELSE COALESCE(sold_at, NOW()) END,
         updated_at=NOW()
       WHERE id=$1`,
      [dealId, data.farmer_id, data.deal_no, data.buyer_name || null, data.buyer_member_id, data.buyer_phone,
        data.deal_date, data.area_bigha, data.area_gaz, data.area_mtr, data.sale_rate, data.sale_amount,
        data.purchase_cost, data.other_cost, data.notes, data.status, data.rate_unit, data.gaz_per_bigha],
    );
    return {};
  });
  if (result.error) return res.status(400).json({ message: result.error });
  res.json({ deal: await loadDeal(dealId), message: 'Land sale updated' });
});

/** DELETE /land-deals/:id — receipts cascade, and their ledger rows go with them. */
export const deleteDeal = asyncHandler(async (req, res) => {
  const dealId = Number.parseInt(req.params.id, 10);
  const { rows } = await pool.query('SELECT site_id FROM land_deals WHERE id = $1', [dealId]);
  if (!rows[0]) return res.status(404).json({ message: 'Land sale not found' });
  if (!(await siteAllowed(req, rows[0].site_id))) return res.status(403).json({ message: 'Access denied to this site' });
  // Keep the parent, receipts, broker commissions (their payouts cascade) and the
  // ledger-trigger effects in one recovery batch — the same way a plot delete does.
  await tx(async (client) => {
    await client.query('DELETE FROM plot_commissions_v2 WHERE land_deal_id = $1', [dealId]);
    await client.query('DELETE FROM land_deal_payments WHERE land_deal_id = $1', [dealId]);
    await client.query('DELETE FROM land_deals WHERE id = $1', [dealId]);
  });
  res.json({ message: 'Land sale deleted' });
});

/* ── Receipts ───────────────────────────────────────────────────────────── */

/** GET /land-deals/:id/payments → { deal, payments } */
export const listPayments = asyncHandler(async (req, res) => {
  const dealId = Number.parseInt(req.params.id, 10);
  const visibility = await resolveEntryVisibility(req.user, 'farmers', req.query.created_by);
  const deal = await loadDeal(dealId, visibility.creatorId);
  if (!deal) return res.status(404).json({ message: 'Land sale not found' });
  if (!(await siteAllowed(req, deal.site_id))) return res.status(403).json({ message: 'Access denied to this site' });
  const { rows: payments } = await pool.query(
    `SELECT p.*, u.name AS created_by_name, a.name AS approved_by_name, aa.name AS assigned_admin_name
       FROM land_deal_payments p
       LEFT JOIN users u ON u.id = p.created_by
       LEFT JOIN users a ON a.id = p.approved_by
       LEFT JOIN users aa ON aa.id = p.assigned_admin_id
      WHERE p.land_deal_id = $1
        AND ($2::text IS NULL OR p.created_by = ANY(string_to_array($2::text, ',')::int[]))
      ORDER BY p.date DESC, p.id DESC`,
    [dealId, visibility.creatorId],
  );
  res.json({ deal, payments, entryVisibility: visibility });
});

const paymentPayload = (body) => {
  const mode = String(body.payment_mode || 'CASH').toUpperCase();
  return {
    date: body.date || new Date().toLocaleDateString('en-CA'),
    amount: num(body.amount),
    payment_mode: PAYMENT_MODES.has(mode) ? mode : 'CASH',
    bank_name: body.bank_name ? String(body.bank_name).trim().toUpperCase() : null,
    bank_account_no: body.bank_account_no ? String(body.bank_account_no).trim() : null,
    bank_reference: body.bank_reference ? String(body.bank_reference).trim() : null,
    bank_ifsc: body.bank_ifsc ? String(body.bank_ifsc).trim().toUpperCase() : null,
    cheque_no: body.cheque_no ? String(body.cheque_no).trim() : null,
    remarks: body.remarks ? String(body.remarks).trim() : null,
    voucher_url: body.voucher_url || null,
    assigned_admin_id: optionalNumber(body.assigned_admin_id),
  };
};

/** POST /land-deals/:id/payments — always created pending, like every other money module. */
export const createPayment = asyncHandler(async (req, res) => {
  const dealId = Number.parseInt(req.params.id, 10);
  const { rows } = await pool.query('SELECT id, site_id, status FROM land_deals WHERE id = $1', [dealId]);
  const deal = rows[0];
  if (!deal) return res.status(404).json({ message: 'Land sale not found' });
  if (!(await siteAllowed(req, deal.site_id))) return res.status(403).json({ message: 'Access denied to this site' });
  if (deal.status === 'cancelled') return res.status(400).json({ message: 'This sale is cancelled — reopen it before adding receipts' });
  const data = paymentPayload(req.body);
  if (!(data.amount > 0)) return res.status(400).json({ message: 'Amount must be greater than zero' });

  const { rows: created } = await pool.query(
    `INSERT INTO land_deal_payments (
       land_deal_id, site_id, date, amount, payment_mode, bank_name, bank_account_no,
       bank_reference, bank_ifsc, cheque_no, cheque_status, remarks, voucher_url,
       status, assigned_admin_id, created_by, transaction_time
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'pending',$14,$15,$16::time)
     RETURNING *`,
    [dealId, deal.site_id, data.date, data.amount, data.payment_mode, data.bank_name,
      data.bank_account_no, data.bank_reference, data.bank_ifsc, data.cheque_no,
      data.payment_mode === 'CHEQUE' ? 'PENDING' : null, data.remarks, data.voucher_url,
      data.assigned_admin_id, req.user.id, transactionTimeForWrite()],
  );
  res.status(201).json({ payment: created[0], message: 'Receipt recorded and is pending approval' });
});

/** PUT /land-deals/:id/payments/:paymentId — edits return the row to pending approval. */
export const updatePayment = asyncHandler(async (req, res) => {
  const paymentId = Number.parseInt(req.params.paymentId, 10);
  const { rows } = await pool.query('SELECT p.*, d.site_id AS deal_site FROM land_deal_payments p JOIN land_deals d ON d.id = p.land_deal_id WHERE p.id = $1', [paymentId]);
  const existing = rows[0];
  if (!existing) return res.status(404).json({ message: 'Receipt not found' });
  if (!(await siteAllowed(req, existing.deal_site))) return res.status(403).json({ message: 'Access denied to this site' });
  const data = paymentPayload({ ...existing, ...req.body });
  if (!(data.amount > 0)) return res.status(400).json({ message: 'Amount must be greater than zero' });

  const { rows: updated } = await pool.query(
    `UPDATE land_deal_payments SET
       date=$2, amount=$3, payment_mode=$4, bank_name=$5, bank_account_no=$6, bank_reference=$7,
       bank_ifsc=$8, cheque_no=$9, cheque_status=$10, remarks=$11, voucher_url=$12,
       assigned_admin_id=$13, transaction_time=$14::time, status='pending', approved_by=NULL, approved_at=NULL, updated_at=NOW()
     WHERE id=$1 RETURNING *`,
    [paymentId, data.date, data.amount, data.payment_mode, data.bank_name, data.bank_account_no,
      data.bank_reference, data.bank_ifsc, data.cheque_no,
      data.payment_mode === 'CHEQUE' ? 'PENDING' : null, data.remarks, data.voucher_url, data.assigned_admin_id, transactionTimeForWrite(existing.transaction_time ?? null)],
  );
  res.json({ payment: updated[0], message: 'Receipt updated and sent for approval' });
});

/** DELETE /land-deals/:id/payments/:paymentId */
export const deletePayment = asyncHandler(async (req, res) => {
  const paymentId = Number.parseInt(req.params.paymentId, 10);
  const { rows } = await pool.query('SELECT p.id, d.site_id FROM land_deal_payments p JOIN land_deals d ON d.id = p.land_deal_id WHERE p.id = $1', [paymentId]);
  if (!rows[0]) return res.status(404).json({ message: 'Receipt not found' });
  if (!(await siteAllowed(req, rows[0].site_id))) return res.status(403).json({ message: 'Access denied to this site' });
  await pool.query('DELETE FROM land_deal_payments WHERE id = $1', [paymentId]);
  res.json({ message: 'Receipt deleted' });
});
