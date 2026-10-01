import { randomUUID } from 'node:crypto';
import pool from '../config/db.js';

export const WALLET_ROLES = ['super_admin', 'admin', 'sub_admin'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function walletError(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}
export function positiveId(value) {
  if (!/^\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value)) || Number(value) < 1) {
    throw walletError('Choose a valid wallet user.');
  }
  return Number(value);
}
export function walletAmount(value) {
  const text = String(value ?? '').trim();
  if (!/^\d{1,13}(?:\.\d{1,2})?$/.test(text)) throw walletError('Enter a positive amount with at most two decimal places.');
  const [whole, fraction = ''] = text.split('.');
  const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  if (cents <= 0n) throw walletError('Amount must be greater than zero.');
  return `${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`;
}
function shortNote(value) {
  if (value != null && typeof value !== 'string') throw walletError('Note must be text.');
  const note = (value || '').trim();
  if (note.length > 1000) throw walletError('Keep the note within 1,000 characters.');
  return note;
}
export function uuid(value, label = 'Transfer ID') {
  if (!UUID.test(String(value ?? ''))) throw walletError(`${label} is invalid.`);
  return String(value).toLowerCase();
}

// Read the role and organization from the database, not a possibly older JWT.
export async function walletUser(user, db = pool) {
  const { rows } = await db.query('SELECT id, name, role, organization_id, is_active FROM users WHERE id=$1', [positiveId(user?.id)]);
  const actor = rows[0];
  if (!actor?.is_active || !WALLET_ROLES.includes(actor.role)) throw walletError('Your account cannot access a wallet.', 403);
  return actor;
}

async function transaction(db, callback) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

async function lockAccounts(db, ids) {
  const ordered = [...new Set(ids)].sort((a, b) => a - b);
  for (const id of ordered) await db.query('INSERT INTO wallet_accounts(user_id) VALUES($1) ON CONFLICT DO NOTHING', [id]);
  await db.query('SELECT user_id FROM wallet_accounts WHERE user_id=ANY($1::int[]) ORDER BY user_id FOR UPDATE', [ordered]);
}

export async function createWalletTransfer(user, data, database = pool) {
  const recipientId = positiveId(data.recipient_id);
  const amount = walletAmount(data.amount);
  const key = uuid(data.idempotency_key, 'Request key');
  const note = shortNote(data.note);
  return transaction(database, async db => {
    const actor = await walletUser(user, db);
    if (actor.id === recipientId) throw walletError('Choose someone else to receive this cash.');
    const { rows: recipients } = await db.query(`SELECT id FROM users WHERE id=$1 AND organization_id=$2
      AND is_active=true AND role=ANY($3::text[])`, [recipientId, actor.organization_id, WALLET_ROLES]);
    if (!recipients[0]) throw walletError('Choose an active recipient from your organization.', 403);
    await lockAccounts(db, [actor.id, recipientId]);
    const { rows: existing } = await db.query('SELECT * FROM wallet_transfers WHERE sender_id=$1 AND idempotency_key=$2', [actor.id, key]);
    if (existing[0]) {
      if (Number(existing[0].recipient_id) !== recipientId || walletAmount(existing[0].amount) !== amount || existing[0].note !== note) {
        throw walletError('This request key already belongs to a different transfer.', 409);
      }
      return { transfer: existing[0], replayed: true };
    }
    const reserved = await db.query(`UPDATE wallet_accounts SET reserved_balance=reserved_balance+$2::numeric, updated_at=now()
      WHERE user_id=$1 AND balance-reserved_balance >= $2::numeric RETURNING user_id`, [actor.id, amount]);
    if (!reserved.rows.length) throw walletError('Insufficient available cash. Pending transfers already reserve their amounts.', 409);
    const { rows } = await db.query(`INSERT INTO wallet_transfers(id,sender_id,recipient_id,amount,note,idempotency_key)
      VALUES($1,$2,$3,$4,$5,$6) RETURNING *`, [randomUUID(), actor.id, recipientId, amount, note, key]);
    return { transfer: rows[0], replayed: false };
  });
}

export async function resolveWalletTransfer(user, transferId, action, data = {}, database = pool) {
  const id = uuid(transferId);
  const status = { accept: 'accepted', reject: 'rejected', cancel: 'cancelled' }[action];
  if (!status) throw walletError('Unknown transfer action.');
  const note = shortNote(data.note);
  return transaction(database, async db => {
    const actor = await walletUser(user, db);
    const { rows } = await db.query(`SELECT t.* FROM wallet_transfers t
      JOIN users sender ON sender.id=t.sender_id JOIN users recipient ON recipient.id=t.recipient_id
      WHERE t.id=$1 AND sender.organization_id=$2 AND recipient.organization_id=$2
        AND (t.sender_id=$3 OR t.recipient_id=$3) FOR UPDATE OF t`, [id, actor.organization_id, actor.id]);
    const transfer = rows[0];
    if (!transfer) throw walletError('Transfer not found.', 404);
    if (actor.id !== Number(action === 'cancel' ? transfer.sender_id : transfer.recipient_id)) {
      throw walletError(action === 'cancel' ? 'Only the sender can cancel this transfer.' : 'Only the recipient can accept or reject this transfer.', 403);
    }
    if (transfer.status === status) return { transfer, replayed: true };
    if (transfer.status !== 'pending') throw walletError(`This transfer is already ${transfer.status}.`, 409);
    await lockAccounts(db, [transfer.sender_id, transfer.recipient_id]);
    if (action === 'accept') {
      const { rows: funds } = await db.query(`SELECT user_id FROM wallet_accounts
        WHERE user_id=$1 AND balance >= $2::numeric AND reserved_balance >= $2::numeric`, [transfer.sender_id, transfer.amount]);
      if (!funds.length) throw walletError('The sender’s cash balance changed. Ask them to cancel this request or collect sufficient cash.', 409);
      await db.query(`SELECT wallet_apply_delta($1,-$2::numeric,'transfer_out',$3,NULL,NULL,$4,$5)`,
        [transfer.sender_id, transfer.amount, `Cash handover accepted${transfer.note ? `: ${transfer.note}` : ''}`, id, transfer.recipient_id]);
      await db.query(`SELECT wallet_apply_delta($1,$2::numeric,'transfer_in',$3,NULL,NULL,$4,$5)`,
        [transfer.recipient_id, transfer.amount, `Cash handover received${transfer.note ? `: ${transfer.note}` : ''}`, id, transfer.sender_id]);
    }
    await db.query('UPDATE wallet_accounts SET reserved_balance=reserved_balance-$2::numeric,updated_at=now() WHERE user_id=$1', [transfer.sender_id, transfer.amount]);
    const resolved = await db.query(`UPDATE wallet_transfers SET status=$2,resolved_at=now(),resolved_by=$3,resolution_note=$4
      WHERE id=$1 RETURNING *`, [id, status, actor.id, note]);
    return { transfer: resolved.rows[0], replayed: false };
  });
}

export function pagination(query) {
  const page = Number(query.page ?? 1), limit = Number(query.limit ?? 25);
  if (!Number.isSafeInteger(page) || page < 1 || page > 1000000 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw walletError('Invalid pagination.');
  return { page, limit, offset: (page - 1) * limit };
}
export function historyDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value)) || !Number.isFinite(Date.parse(`${value}T00:00:00Z`)) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) {
    throw walletError('Choose a valid history date.');
  }
  return value;
}
