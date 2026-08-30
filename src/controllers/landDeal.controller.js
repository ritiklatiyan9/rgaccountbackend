// Land Profit — the SELL side of the Farmers module.
//
// A `land_deals` row is one parcel (bought from a farmer, tracked in farmers /
// farmer_payments) resold to another farmer or party. `land_deal_payments` are the
// buyer's receipts and are the ONLY rows here that move money: a trigger mirrors them
// into cash_flow_entries as CREDITs (migration 109), so the Day Book, Balance Sheet and
// Site Balance see them exactly like plot receipts.
//
// `purchase_cost` is an ALLOCATION of what we already paid the seller — it never posts
// to the ledger (the farmer payments already did) and exists only for:
//     profit = sale_amount - purchase_cost - other_cost
import asyncHandler from '../utils/asyncHandler.js';
import pool from '../config/db.js';
import { resolveEntryVisibility } from '../services/entryVisibility.service.js';

const ADMIN_ROLES = new Set(['admin', 'super_admin']);
const GAZ_TO_SQ_METRE = 0.8364;
// Lifecycle: purchased (paying the farmer; 100% paid = held) → open (sold, collecting) → completed.
const DEAL_STATUSES = new Set(['purchased', 'open', 'completed', 'cancelled']);
const SOLD_STATUSES = new Set(['open', 'completed']);
const RATE_UNITS = new Set(['bigha', 'gaz', 'mtr']);
const PAYMENT_MODES = new Set(['CASH', 'BANK', 'CHEQUE', 'UPI', 'NEFT', 'RTGS', 'IMPS', 'TRANSFER']);

// Buyer receipts are credits, so they post while Pending. Cheques still wait
// for CLEARED. The badge/status itself is not changed by this predicate.
const ACTIVE_PAYMENT = `financial_transaction_posts('credit', p.status, p.payment_mode, p.cheque_status)`;

const num = (v) => (Number(v) || 0);
const money = (v) => Math.round(num(v) * 100) / 100;
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

/** site_id from query or body + user_sites gate (admins bypass). Responds and returns null on failure. */
const resolveSite = async (req, res, source = 'query') => {
  const raw = source === 'body' ? req.body?.site_id : req.query?.site_id;
  const siteId = Number.parseInt(raw, 10);
  if (!Number.isInteger(siteId) || siteId <= 0) {
    res.status(400).json({ message: 'site_id is required' });
    return null;
  }
  if (!ADMIN_ROLES.has(req.user.role)) {
    const { rows } = await pool.query('SELECT 1 FROM user_sites WHERE user_id = $1 AND site_id = $2 LIMIT 1', [req.user.id, siteId]);
    if (!rows[0]) { res.status(403).json({ message: 'Access denied to this site' }); return null; }
  }
  return siteId;
};

/** The deal row plus its money rollup. Returns null when the deal does not exist. */
const loadDeal = async (dealId, creatorId = null) => {
  const { rows } = await pool.query(
    `SELECT d.*,
            f.name AS farmer_name, f.land_rate AS farmer_land_rate, f.total_amount AS farmer_total_amount,
            m.full_name AS buyer_member_name,
            u.name AS created_by_name,
            COALESCE((SELECT SUM(fp.amount) FROM farmer_payments fp
                       WHERE fp.farmer_id = d.farmer_id
                         AND financial_transaction_posts('debit', fp.status, fp.payment_mode, fp.cheque_status)), 0)::numeric(15,2) AS paid_to_farmer,
            COALESCE(SUM(p.amount) FILTER (WHERE ${ACTIVE_PAYMENT}), 0)::numeric(15,2) AS received,
            COALESCE(SUM(p.amount) FILTER (WHERE ${ACTIVE_PAYMENT} AND ledger_bucket(p.payment_mode) = 'cash'), 0)::numeric(15,2) AS cash_received,
            COALESCE(SUM(p.amount) FILTER (WHERE ${ACTIVE_PAYMENT} AND ledger_bucket(p.payment_mode) <> 'cash'), 0)::numeric(15,2) AS bank_received,
            COALESCE(SUM(p.amount) FILTER (WHERE LOWER(COALESCE(p.status, 'approved')) = 'pending'), 0)::numeric(15,2) AS pending_amount,
            COUNT(p.id) FILTER (WHERE p.id IS NOT NULL)::int AS payment_count,
            MAX(p.date) FILTER (WHERE ${ACTIVE_PAYMENT}) AS last_payment_date
       FROM land_deals d
       LEFT JOIN farmers f ON f.id = d.farmer_id
       LEFT JOIN members m ON m.id = d.buyer_member_id
       LEFT JOIN users u ON u.id = d.created_by
       LEFT JOIN land_deal_payments p ON p.land_deal_id = d.id
            AND ($2::int IS NULL OR p.created_by = $2::int)
      WHERE d.id = $1
      GROUP BY d.id, f.id, m.id, u.id`,
    [dealId, creatorId],
  );
  return rows[0] ? withProfit(rows[0]) : null;
};

/** profit = sale − purchase cost − other cost; outstanding = sale − received. */
/** Where the deal sits in the lifecycle: paying → held (100% paid) → sold; cancelled aside. */
const stageOf = (row, purchaseCost, paidToFarmer) => {
  if (row.status === 'cancelled') return 'cancelled';
  if (SOLD_STATUSES.has(row.status)) return 'sold';
  return purchaseCost > 0 && paidToFarmer >= purchaseCost - 0.005 ? 'held' : 'paying';
};

const withProfit = (row) => {
  const sale = num(row.sale_amount);
  // Purchase cost defaults to the farmer's agreed land price when the deal never set one.
  const purchaseCost = num(row.purchase_cost) > 0 ? num(row.purchase_cost) : num(row.farmer_total_amount);
  const cost = purchaseCost + num(row.other_cost);
  const received = num(row.received);
  const paidToFarmer = num(row.paid_to_farmer);
  const profit = sale - cost;
  const stage = stageOf(row, purchaseCost, paidToFarmer);
  return {
    ...row,
    stage,
    is_sold: stage === 'sold',
    sale_amount: money(sale),
    purchase_cost: money(purchaseCost),
    other_cost: money(row.other_cost),
    total_cost: money(cost),
    paid_to_farmer: money(paidToFarmer),
    farmer_balance: money(Math.max(purchaseCost - paidToFarmer, 0)),
    purchase_paid_pct: purchaseCost > 0 ? Math.round(Math.min(paidToFarmer / purchaseCost, 1) * 1000) / 10 : 0,
    profit: money(profit),
    margin_pct: sale > 0 ? Math.round((profit / sale) * 1000) / 10 : 0,
    received: money(received),
    cash_received: money(row.cash_received),
    bank_received: money(row.bank_received),
    pending_amount: money(row.pending_amount),
    outstanding: money(Math.max(sale - received, 0)),
    collected_pct: sale > 0 ? Math.round(Math.min(received / sale, 1) * 1000) / 10 : 0,
  };
};

const summarise = (deals) => deals.reduce((acc, d) => {
  const live = d.status !== 'cancelled';
  acc.deals += 1;
  acc[d.status] = (acc[d.status] || 0) + 1;
  acc[d.stage] = (acc[d.stage] || 0) + 1;
  if (live) {
    acc.invested += d.purchase_cost;
    acc.paid_to_farmers += d.paid_to_farmer;
    acc.farmer_balance += d.farmer_balance;
    acc.total_cost += d.total_cost;
    if (d.is_sold) {
      acc.sale_value += d.sale_amount;
      acc.profit += d.profit;
      acc.received += d.received;
      acc.outstanding += d.outstanding;
      acc.cash_received += d.cash_received;
      acc.bank_received += d.bank_received;
    }
  }
  return acc;
}, { deals: 0, purchased: 0, open: 0, completed: 0, cancelled: 0, paying: 0, held: 0, sold: 0,
  invested: 0, paid_to_farmers: 0, farmer_balance: 0, sale_value: 0, total_cost: 0, profit: 0, received: 0, outstanding: 0, cash_received: 0, bank_received: 0 });

/* ── Deals ──────────────────────────────────────────────────────────────── */

/** GET /land-deals?site_id=&status=&farmer_id= → { deals, summary } */
export const listDeals = asyncHandler(async (req, res) => {
  const siteId = await resolveSite(req, res);
  if (!siteId) return;
  const visibility = await resolveEntryVisibility(req.user, 'farmers', req.query.created_by);
  const status = DEAL_STATUSES.has(req.query.status) ? req.query.status : null;
  const farmerId = Number.parseInt(req.query.farmer_id, 10);

  const { rows } = await pool.query(
    `SELECT d.*,
            f.name AS farmer_name, f.land_rate AS farmer_land_rate, f.total_amount AS farmer_total_amount,
            m.full_name AS buyer_member_name,
            COALESCE((SELECT SUM(fp.amount) FROM farmer_payments fp
                       WHERE fp.farmer_id = d.farmer_id
                         AND financial_transaction_posts('debit', fp.status, fp.payment_mode, fp.cheque_status)), 0)::numeric(15,2) AS paid_to_farmer,
            COALESCE(SUM(p.amount) FILTER (WHERE ${ACTIVE_PAYMENT}), 0)::numeric(15,2) AS received,
            COALESCE(SUM(p.amount) FILTER (WHERE ${ACTIVE_PAYMENT} AND ledger_bucket(p.payment_mode) = 'cash'), 0)::numeric(15,2) AS cash_received,
            COALESCE(SUM(p.amount) FILTER (WHERE ${ACTIVE_PAYMENT} AND ledger_bucket(p.payment_mode) <> 'cash'), 0)::numeric(15,2) AS bank_received,
            COALESCE(SUM(p.amount) FILTER (WHERE LOWER(COALESCE(p.status, 'approved')) = 'pending'), 0)::numeric(15,2) AS pending_amount,
            COUNT(p.id) FILTER (WHERE p.id IS NOT NULL)::int AS payment_count,
            MAX(p.date) FILTER (WHERE ${ACTIVE_PAYMENT}) AS last_payment_date
       FROM land_deals d
       LEFT JOIN farmers f ON f.id = d.farmer_id
       LEFT JOIN members m ON m.id = d.buyer_member_id
       LEFT JOIN land_deal_payments p ON p.land_deal_id = d.id
            AND ($4::int IS NULL OR p.created_by = $4::int)
      WHERE d.site_id = $1
        AND ($2::text IS NULL OR d.status = $2::text)
        AND ($3::int IS NULL OR d.farmer_id = $3::int)
      GROUP BY d.id, f.id, m.id
      ORDER BY d.deal_date DESC, d.id DESC`,
    [siteId, status, Number.isInteger(farmerId) ? farmerId : null, visibility.creatorId],
  );

  const deals = rows.map(withProfit);
  res.json({ deals, summary: summarise(deals), entryVisibility: visibility });
});

/** GET /land-deals/:id → { deal } */
export const getDeal = asyncHandler(async (req, res) => {
  const visibility = await resolveEntryVisibility(req.user, 'farmers', req.query.created_by);
  const deal = await loadDeal(Number.parseInt(req.params.id, 10), visibility.creatorId);
  if (!deal) return res.status(404).json({ message: 'Land deal not found' });
  if (!ADMIN_ROLES.has(req.user.role)) {
    const { rows } = await pool.query('SELECT 1 FROM user_sites WHERE user_id = $1 AND site_id = $2 LIMIT 1', [req.user.id, deal.site_id]);
    if (!rows[0]) return res.status(403).json({ message: 'Access denied to this site' });
  }
  res.json({ deal });
});

const dealPayload = (body) => {
  const area = normalizeArea(body.area_gaz, body.area_mtr);
  return {
    farmer_id: optionalNumber(body.farmer_id),
    deal_no: body.deal_no ? String(body.deal_no).trim() : null,
    buyer_name: String(body.buyer_name || '').trim().toUpperCase(),
    buyer_member_id: optionalNumber(body.buyer_member_id),
    buyer_phone: body.buyer_phone ? String(body.buyer_phone).trim() : null,
    deal_date: body.deal_date || new Date().toLocaleDateString('en-CA'),
    purchase_date: body.purchase_date || null,
    area_bigha: optionalNumber(body.area_bigha),
    ...area,
    sale_rate: optionalNumber(body.sale_rate),
    purchase_rate: optionalNumber(body.purchase_rate),
    rate_unit: RATE_UNITS.has(body.rate_unit) ? body.rate_unit : 'bigha',
    gaz_per_bigha: optionalNumber(body.gaz_per_bigha),
    sale_amount: Math.max(num(body.sale_amount), 0),
    purchase_cost: Math.max(num(body.purchase_cost), 0),
    other_cost: Math.max(num(body.other_cost), 0),
    notes: body.notes ? String(body.notes).trim() : null,
    status: DEAL_STATUSES.has(body.status) ? body.status : 'open',
  };
};

/** Sold deals need a buyer and a sale amount; a purchased (unsold) deal needs the farmer it was bought from. */
const validateDeal = (data, res) => {
  if (data.status === 'purchased') {
    if (!data.farmer_id) { res.status(400).json({ message: 'Pick the farmer the land was bought from' }); return false; }
    return true;
  }
  if (data.status === 'cancelled') return true;
  if (!data.buyer_name) { res.status(400).json({ message: 'Buyer name is required to mark the land as sold' }); return false; }
  if (data.sale_amount <= 0) { res.status(400).json({ message: 'Sale amount must be greater than zero' }); return false; }
  return true;
};

/** POST /land-deals → { deal } */
export const createDeal = asyncHandler(async (req, res) => {
  const siteId = await resolveSite(req, res, 'body');
  if (!siteId) return;
  const data = dealPayload(req.body);
  if (!validateDeal(data, res)) return;
  if (data.farmer_id) {
    const { rows: f } = await pool.query('SELECT site_id, total_amount FROM farmers WHERE id = $1', [data.farmer_id]);
    if (!f[0]) return res.status(400).json({ message: 'Farmer not found' });
    if (Number(f[0].site_id) !== siteId) return res.status(400).json({ message: 'That farmer belongs to another site' });
    if (!(data.purchase_cost > 0)) data.purchase_cost = Math.max(num(f[0].total_amount), 0);
  }
  if (data.status === 'purchased' && !data.purchase_date) data.purchase_date = data.deal_date;

  const { rows } = await pool.query(
    `INSERT INTO land_deals (
       site_id, farmer_id, deal_no, buyer_name, buyer_member_id, buyer_phone, deal_date,
       area_bigha, area_gaz, area_mtr, sale_rate, sale_amount, purchase_cost, other_cost,
       notes, status, created_by, purchase_date, purchase_rate, rate_unit, gaz_per_bigha, sold_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::text,$17,$18,$19,$20,$21,
               CASE WHEN $16::text IN ('open', 'completed') THEN NOW() ELSE NULL END)
     RETURNING id`,
    [siteId, data.farmer_id, data.deal_no, data.buyer_name || null, data.buyer_member_id, data.buyer_phone,
      data.deal_date, data.area_bigha, data.area_gaz, data.area_mtr, data.sale_rate,
      data.sale_amount, data.purchase_cost, data.other_cost, data.notes, data.status, req.user.id,
      data.purchase_date, data.purchase_rate, data.rate_unit, data.gaz_per_bigha],
  );
  res.status(201).json({ deal: await loadDeal(rows[0].id) });
});

/** PUT /land-deals/:id → { deal } */
export const updateDeal = asyncHandler(async (req, res) => {
  const dealId = Number.parseInt(req.params.id, 10);
  const existing = await loadDeal(dealId);
  if (!existing) return res.status(404).json({ message: 'Land deal not found' });
  if (!ADMIN_ROLES.has(req.user.role)) {
    const { rows } = await pool.query('SELECT 1 FROM user_sites WHERE user_id = $1 AND site_id = $2 LIMIT 1', [req.user.id, existing.site_id]);
    if (!rows[0]) return res.status(403).json({ message: 'Access denied to this site' });
  }
  await applyDealUpdate(dealId, existing, req.body, res);
});

/** Shared by PUT /:id and POST /:id/sell. Marks sold_at on the purchased → sold transition. */
const applyDealUpdate = async (dealId, existing, body, res) => {
  const data = dealPayload({ ...existing, ...body });
  if (!validateDeal(data, res)) return;
  const becomesSold = SOLD_STATUSES.has(data.status) && !SOLD_STATUSES.has(existing.status);
  await pool.query(
    `UPDATE land_deals SET
       farmer_id=$2, deal_no=$3, buyer_name=$4, buyer_member_id=$5, buyer_phone=$6, deal_date=$7,
       area_bigha=$8, area_gaz=$9, area_mtr=$10, sale_rate=$11, sale_amount=$12,
       purchase_cost=$13, other_cost=$14, notes=$15, status=$16::text,
       purchase_date=$17, purchase_rate=$18, rate_unit=$19, gaz_per_bigha=$20,
       sold_at = CASE WHEN $21::boolean THEN NOW() WHEN $16::text = 'purchased' THEN NULL ELSE sold_at END,
       updated_at=NOW()
     WHERE id=$1`,
    [dealId, data.farmer_id, data.deal_no, data.buyer_name || null, data.buyer_member_id, data.buyer_phone,
      data.deal_date, data.area_bigha, data.area_gaz, data.area_mtr, data.sale_rate,
      data.sale_amount, data.purchase_cost, data.other_cost, data.notes, data.status,
      data.purchase_date, data.purchase_rate, data.rate_unit, data.gaz_per_bigha, becomesSold],
  );
  res.json({ deal: await loadDeal(dealId), message: becomesSold ? 'Land marked as sold — profit is now tracked on this deal' : 'Deal updated' });
};

/** POST /land-deals/:id/sell — the "Mark as sold" action: buyer + sale values → profit. */
export const sellDeal = asyncHandler(async (req, res) => {
  const dealId = Number.parseInt(req.params.id, 10);
  const existing = await loadDeal(dealId);
  if (!existing) return res.status(404).json({ message: 'Land deal not found' });
  if (!ADMIN_ROLES.has(req.user.role)) {
    const { rows } = await pool.query('SELECT 1 FROM user_sites WHERE user_id = $1 AND site_id = $2 LIMIT 1', [req.user.id, existing.site_id]);
    if (!rows[0]) return res.status(403).json({ message: 'Access denied to this site' });
  }
  const status = SOLD_STATUSES.has(req.body.status) ? req.body.status : 'open';
  await applyDealUpdate(dealId, existing, { ...req.body, status, deal_date: req.body.deal_date || new Date().toLocaleDateString('en-CA') }, res);
});

/** DELETE /land-deals/:id — payments cascade, and their ledger rows go with them. */
export const deleteDeal = asyncHandler(async (req, res) => {
  const dealId = Number.parseInt(req.params.id, 10);
  const { rows } = await pool.query('SELECT site_id FROM land_deals WHERE id = $1', [dealId]);
  if (!rows[0]) return res.status(404).json({ message: 'Land deal not found' });
  if (!ADMIN_ROLES.has(req.user.role)) {
    const { rows: allowed } = await pool.query('SELECT 1 FROM user_sites WHERE user_id = $1 AND site_id = $2 LIMIT 1', [req.user.id, rows[0].site_id]);
    if (!allowed[0]) return res.status(403).json({ message: 'Access denied to this site' });
  }
  // Keep the parent, receipts, and ledger-trigger effects in one recovery batch.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM land_deal_payments WHERE land_deal_id = $1', [dealId]);
    await client.query('DELETE FROM land_deals WHERE id = $1', [dealId]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
  res.json({ message: 'Land deal deleted' });
});

/* ── Receipts ───────────────────────────────────────────────────────────── */

/** GET /land-deals/:id/payments → { deal, payments } */
export const listPayments = asyncHandler(async (req, res) => {
  const dealId = Number.parseInt(req.params.id, 10);
  const visibility = await resolveEntryVisibility(req.user, 'farmers', req.query.created_by);
  const deal = await loadDeal(dealId, visibility.creatorId);
  if (!deal) return res.status(404).json({ message: 'Land deal not found' });
  if (!ADMIN_ROLES.has(req.user.role)) {
    const { rows } = await pool.query('SELECT 1 FROM user_sites WHERE user_id = $1 AND site_id = $2 LIMIT 1', [req.user.id, deal.site_id]);
    if (!rows[0]) return res.status(403).json({ message: 'Access denied to this site' });
  }
  const { rows: payments } = await pool.query(
    `SELECT p.*, u.name AS created_by_name, a.name AS approved_by_name, aa.name AS assigned_admin_name
       FROM land_deal_payments p
       LEFT JOIN users u ON u.id = p.created_by
       LEFT JOIN users a ON a.id = p.approved_by
       LEFT JOIN users aa ON aa.id = p.assigned_admin_id
      WHERE p.land_deal_id = $1
        AND ($2::int IS NULL OR p.created_by = $2::int)
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
  const { rows } = await pool.query('SELECT id, site_id FROM land_deals WHERE id = $1', [dealId]);
  const deal = rows[0];
  if (!deal) return res.status(404).json({ message: 'Land deal not found' });
  if (!ADMIN_ROLES.has(req.user.role)) {
    const { rows: allowed } = await pool.query('SELECT 1 FROM user_sites WHERE user_id = $1 AND site_id = $2 LIMIT 1', [req.user.id, deal.site_id]);
    if (!allowed[0]) return res.status(403).json({ message: 'Access denied to this site' });
  }
  const data = paymentPayload(req.body);
  if (!(data.amount > 0)) return res.status(400).json({ message: 'Amount must be greater than zero' });

  const { rows: created } = await pool.query(
    `INSERT INTO land_deal_payments (
       land_deal_id, site_id, date, amount, payment_mode, bank_name, bank_account_no,
       bank_reference, bank_ifsc, cheque_no, cheque_status, remarks, voucher_url,
       status, assigned_admin_id, created_by
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'pending',$14,$15)
     RETURNING *`,
    [dealId, deal.site_id, data.date, data.amount, data.payment_mode, data.bank_name,
      data.bank_account_no, data.bank_reference, data.bank_ifsc, data.cheque_no,
      data.payment_mode === 'CHEQUE' ? 'PENDING' : null, data.remarks, data.voucher_url,
      data.assigned_admin_id, req.user.id],
  );
  res.status(201).json({ payment: created[0], message: 'Receipt recorded and is pending approval' });
});

/** PUT /land-deals/:id/payments/:paymentId — edits return the row to pending approval. */
export const updatePayment = asyncHandler(async (req, res) => {
  const paymentId = Number.parseInt(req.params.paymentId, 10);
  const { rows } = await pool.query('SELECT p.*, d.site_id AS deal_site FROM land_deal_payments p JOIN land_deals d ON d.id = p.land_deal_id WHERE p.id = $1', [paymentId]);
  const existing = rows[0];
  if (!existing) return res.status(404).json({ message: 'Receipt not found' });
  if (!ADMIN_ROLES.has(req.user.role)) {
    const { rows: allowed } = await pool.query('SELECT 1 FROM user_sites WHERE user_id = $1 AND site_id = $2 LIMIT 1', [req.user.id, existing.deal_site]);
    if (!allowed[0]) return res.status(403).json({ message: 'Access denied to this site' });
  }
  const data = paymentPayload({ ...existing, ...req.body });
  if (!(data.amount > 0)) return res.status(400).json({ message: 'Amount must be greater than zero' });

  const { rows: updated } = await pool.query(
    `UPDATE land_deal_payments SET
       date=$2, amount=$3, payment_mode=$4, bank_name=$5, bank_account_no=$6, bank_reference=$7,
       bank_ifsc=$8, cheque_no=$9, cheque_status=$10, remarks=$11, voucher_url=$12,
       assigned_admin_id=$13, status='pending', approved_by=NULL, approved_at=NULL, updated_at=NOW()
     WHERE id=$1 RETURNING *`,
    [paymentId, data.date, data.amount, data.payment_mode, data.bank_name, data.bank_account_no,
      data.bank_reference, data.bank_ifsc, data.cheque_no,
      data.payment_mode === 'CHEQUE' ? 'PENDING' : null, data.remarks, data.voucher_url, data.assigned_admin_id],
  );
  res.json({ payment: updated[0], message: 'Receipt updated and sent for approval' });
});

/** DELETE /land-deals/:id/payments/:paymentId */
export const deletePayment = asyncHandler(async (req, res) => {
  const paymentId = Number.parseInt(req.params.paymentId, 10);
  const { rows } = await pool.query('SELECT p.id, d.site_id FROM land_deal_payments p JOIN land_deals d ON d.id = p.land_deal_id WHERE p.id = $1', [paymentId]);
  if (!rows[0]) return res.status(404).json({ message: 'Receipt not found' });
  if (!ADMIN_ROLES.has(req.user.role)) {
    const { rows: allowed } = await pool.query('SELECT 1 FROM user_sites WHERE user_id = $1 AND site_id = $2 LIMIT 1', [req.user.id, rows[0].site_id]);
    if (!allowed[0]) return res.status(403).json({ message: 'Access denied to this site' });
  }
  await pool.query('DELETE FROM land_deal_payments WHERE id = $1', [paymentId]);
  res.json({ message: 'Receipt deleted' });
});
