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
    (SELECT count(*)::int FROM wallet_transfers WHERE sender_id=$1 AND status='pending') AS pending_outgoing
    FROM wallet_settings s LEFT JOIN wallet_accounts w ON w.user_id=$1 LIMIT 1`, [actor.id]);
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
  const where = clauses.join(' AND ');
  const count = await pool.query(`SELECT count(*)::int AS total FROM wallet_entries e WHERE ${where}`, params);
  const { rows } = await pool.query(`SELECT e.*,u.name AS counterparty_name FROM wallet_entries e
    LEFT JOIN users u ON u.id=e.counterparty_id WHERE ${where} ORDER BY e.id DESC LIMIT $${params.length+1} OFFSET $${params.length+2}`, [...params,limit,offset]);
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
  const joins = 'FROM wallet_transfers t JOIN users sender ON sender.id=t.sender_id JOIN users recipient ON recipient.id=t.recipient_id';
  const count = await pool.query(`SELECT count(*)::int AS total ${joins} WHERE ${where}`, params);
  const { rows } = await pool.query(`SELECT t.*,sender.name AS sender_name,recipient.name AS recipient_name ${joins}
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
