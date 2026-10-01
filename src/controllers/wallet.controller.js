import pool from '../config/db.js';
import asyncHandler from '../utils/asyncHandler.js';
import { WALLET_ROLES, walletUser, walletError, pagination, historyDate, createWalletTransfer, resolveWalletTransfer } from '../services/wallet.service.js';

export const summary = asyncHandler(async (req, res) => {
  const actor = await walletUser(req.user);
  const { rows } = await pool.query(`SELECT $1::int AS user_id,COALESCE(w.balance,0)::text AS balance,
    COALESCE(w.reserved_balance,0)::text AS reserved_balance,
    (COALESCE(w.balance,0)-COALESCE(w.reserved_balance,0))::text AS available_balance,
    'INR' AS currency,s.tracking_started_at,
    (SELECT count(*)::int FROM wallet_transfers WHERE recipient_id=$1 AND status='pending') AS pending_incoming,
    (SELECT count(*)::int FROM wallet_transfers WHERE sender_id=$1 AND status='pending') AS pending_outgoing,
    (SELECT COALESCE(sum(amount),0)::text FROM wallet_transfers WHERE recipient_id=$1 AND status='pending') AS pending_incoming_amount,
    totals.collected_amount,totals.received_amount,totals.sent_amount,totals.entry_count,totals.last_activity_at,
    now() AS refreshed_at
    FROM wallet_settings s LEFT JOIN wallet_accounts w ON w.user_id=$1
    CROSS JOIN LATERAL (SELECT
      COALESCE(sum(amount) FILTER (WHERE kind IN ('receipt','adjustment','reversal')),0)::text AS collected_amount,
      COALESCE(sum(amount) FILTER (WHERE kind='transfer_in'),0)::text AS received_amount,
      COALESCE(-sum(amount) FILTER (WHERE kind='transfer_out'),0)::text AS sent_amount,
      count(*)::int AS entry_count,max(created_at) AS last_activity_at
      FROM wallet_entries WHERE user_id=$1) totals LIMIT 1`, [actor.id]);
  if (!rows[0]) throw walletError('Wallet setup has not been completed.', 503);
  const { pending_incoming, pending_outgoing, ...wallet } = rows[0];
  res.json({ wallet, pending_incoming, pending_outgoing });
});

export const people = asyncHandler(async (req, res) => {
  const actor = await walletUser(req.user);
  const { rows } = await pool.query(`SELECT id,name,role FROM users WHERE id<>$1 AND organization_id=$2
    AND is_active=true AND role=ANY($3::text[]) ORDER BY CASE role WHEN 'super_admin' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END,name,id`,
  [actor.id, actor.organization_id, WALLET_ROLES]);
  res.json({ users: rows });
});

export const history = asyncHandler(async (req, res) => {
  const actor = await walletUser(req.user);
  const { page, limit, offset } = pagination(req.query);
  const params = [actor.id];
  const clauses = ['e.user_id=$1'];
  const type = req.query.type || 'all';
  if (type !== 'all') {
    if (!['receipt','adjustment','reversal','transfer_in','transfer_out'].includes(type)) throw walletError('Unknown history type.');
    params.push(type); clauses.push(`e.kind=$${params.length}`);
  }
  if (req.query.from) { params.push(historyDate(req.query.from)); clauses.push(`e.created_at >= ($${params.length}::date::timestamp AT TIME ZONE 'Asia/Kolkata')`); }
  if (req.query.to) { params.push(historyDate(req.query.to)); clauses.push(`e.created_at < (($${params.length}::date+1)::timestamp AT TIME ZONE 'Asia/Kolkata')`); }
  if (req.query.from && req.query.to && req.query.from > req.query.to) throw walletError('Start date must be on or before end date.');
  if (req.query.site_id) {
    const siteId=Number(req.query.site_id);
    if (!Number.isSafeInteger(siteId)||siteId<1) throw walletError('Choose a valid site.');
    params.push(String(siteId)); clauses.push(`d.details->>'site_id'=$${params.length}`);
  }
  const search=String(req.query.q||'').trim();
  if (search.length>200) throw walletError('Keep your search within 200 characters.');
  if (search) {
    params.push(`%${search.replace(/[\\%_]/g,'\\$&')}%`);
    clauses.push(`concat_ws(' ',e.description,e.source_table,e.source_id::text,e.transfer_id::text,d.details->>'site_name',
      d.details->>'party_name',d.details->>'plot_no',d.details->>'notes',d.details->>'reference',
      d.details->>'ledger_name',d.details->>'collector_name',u.name) ILIKE $${params.length} ESCAPE '\\'`);
  }
  const where = clauses.join(' AND ');
  const joins=`FROM wallet_entries e LEFT JOIN wallet_entry_details d ON d.wallet_entry_id=e.id
    LEFT JOIN users u ON u.id=e.counterparty_id LEFT JOIN wallet_transfers t ON t.id=e.transfer_id
    LEFT JOIN users resolver ON resolver.id=t.resolved_by`;
  const count = await pool.query(`SELECT count(*)::int AS total ${joins} WHERE ${where}`, params);
  const { rows } = await pool.query(`SELECT e.*,COALESCE(d.details,'{}'::jsonb) AS source_details,
    u.name AS counterparty_name,u.role AS counterparty_role,t.status AS transfer_status,t.note AS transfer_note,
    t.created_at AS requested_at,t.resolved_at,t.resolution_note,resolver.name AS resolved_by_name
    ${joins} WHERE ${where} ORDER BY e.id DESC LIMIT $${params.length+1} OFFSET $${params.length+2}`, [...params,limit,offset]);
  res.json({ entries: rows, total: count.rows[0].total, page, limit });
});

export const transfers = asyncHandler(async (req, res) => {
  const actor = await walletUser(req.user);
  const { page, limit, offset } = pagination(req.query);
  const params = [actor.id, actor.organization_id];
  let where = '(t.sender_id=$1 OR t.recipient_id=$1) AND sender.organization_id=$2 AND recipient.organization_id=$2';
  const status = req.query.status || 'all';
  if (status !== 'all') {
    if (!['pending','accepted','rejected','cancelled'].includes(status)) throw walletError('Unknown transfer status.');
    params.push(status); where += ` AND t.status=$${params.length}`;
  }
  const direction=req.query.direction||'all';
  if (!['all','incoming','outgoing'].includes(direction)) throw walletError('Unknown transfer direction.');
  if (direction==='incoming') where+=' AND t.recipient_id=$1';
  if (direction==='outgoing') where+=' AND t.sender_id=$1';
  const joins = 'FROM wallet_transfers t JOIN users sender ON sender.id=t.sender_id JOIN users recipient ON recipient.id=t.recipient_id';
  const count = await pool.query(`SELECT count(*)::int AS total ${joins} WHERE ${where}`, params);
  const { rows } = await pool.query(`SELECT t.*,sender.name AS sender_name,sender.role AS sender_role,
    recipient.name AS recipient_name,recipient.role AS recipient_role,
    (SELECT name FROM users WHERE id=t.resolved_by) AS resolved_by_name ${joins}
    WHERE ${where} ORDER BY t.created_at DESC,t.id DESC LIMIT $${params.length+1} OFFSET $${params.length+2}`, [...params,limit,offset]);
  res.json({ transfers: rows, total: count.rows[0].total, page, limit });
});

export const createTransfer = asyncHandler(async (req, res) => {
  const result = await createWalletTransfer(req.user, req.body || {});
  res.status(result.replayed ? 200 : 201).json(result);
});
export const resolveTransfer = action => asyncHandler(async (req, res) => {
  res.json(await resolveWalletTransfer(req.user, req.params.id, action, req.body || {}));
});
