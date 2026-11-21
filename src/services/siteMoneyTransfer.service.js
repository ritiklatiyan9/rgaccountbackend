import pool from '../config/db.js';
import { transaction, moneyMinor, moneyDecimal } from './cashflowTransfer.service.js';
import { currentTransactionDate, transactionDateEditable } from './transactionDate.service.js';

// Main Site Balance → another site. A request waits for the approver it names;
// approval posts the debit and credit legs (migration 256) in one transaction.
const fail = (message, statusCode = 400, code) => Object.assign(new Error(message), { statusCode, code });
const ADMIN_ROLES = new Set(['admin', 'super_admin']);
const reference = id => `SMT-${id}`;
const inr = value => `₹${Number(value).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

function positiveId(value, label) {
  if (!/^\d+$/.test(String(value ?? '')) || Number(value) < 1 || Number(value) > 2147483647) throw fail(`Choose ${label}.`);
  return Number(value);
}

/** Validates a create request. `today` is the IST business date (YYYY-MM-DD). */
export function parseTransferRequest(body = {}, today) {
  const sourceSiteId = positiveId(body.source_site_id, 'the sending site');
  const destinationSiteId = positiveId(body.destination_site_id, 'the receiving site');
  if (sourceSiteId === destinationSiteId) throw fail('Choose a different receiving site.');
  const minor = moneyMinor(String(body.amount ?? '').trim());
  if (minor <= 0n) throw fail('Enter an amount greater than zero.');
  const mode = String(body.mode || '').toLowerCase();
  if (!['cash', 'bank'].includes(mode)) throw fail('Choose Cash or Bank.');
  const date = String(body.date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date) throw fail('Choose a valid transfer date.');
  if (date > today) throw fail('The transfer date cannot be in the future.');
  const time = String(body.time || '');
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(time)) throw fail('Choose a valid transfer time.');
  if (body.remarks != null && typeof body.remarks !== 'string') throw fail('Remarks must be text.');
  const remarks = (body.remarks || '').trim();
  if (remarks.length > 1000) throw fail('Keep remarks within 1000 characters.');
  const bank = (value, label) => mode === 'bank' && value != null && value !== '' ? positiveId(value, label) : null;
  return {
    sourceSiteId, destinationSiteId, amount: moneyDecimal(minor), mode, date, time: time.length === 5 ? `${time}:00` : time,
    approverId: positiveId(body.approver_id, 'who should approve'),
    sourceBankId: bank(body.source_bank_account_id, 'a valid sending bank account'),
    destinationBankId: bank(body.destination_bank_account_id, 'a valid receiving bank account'),
    remarks,
  };
}

async function actorFor(user, db) {
  if (!user?.id) throw fail('Authentication required', 401);
  const { rows: [actor] } = await db.query('SELECT id, name, role, organization_id, is_active FROM users WHERE id=$1', [user.id]);
  if (!actor?.is_active || !['admin', 'super_admin', 'sub_admin'].includes(actor.role)) throw fail('Your account cannot transfer site money.', 403);
  return { ...actor, isAdmin: ADMIN_ROLES.has(actor.role) };
}

// $1 organisation, $2 actor is admin, $3 actor id.
const SITES_SQL = `SELECT s.id, s.name FROM sites s WHERE s.organization_id=$1
  AND ($2::boolean OR EXISTS (SELECT 1 FROM user_sites us WHERE us.user_id=$3 AND us.site_id=s.id))`;
// Who may approve money leaving a site: any active admin, or a sub-admin of that site.
const approverRule = (alias, org, site) => `${alias}.organization_id=${org} AND ${alias}.is_active
  AND ${alias}.can_login_accounts IS NOT FALSE AND (${alias}.role IN ('admin','super_admin')
    OR (${alias}.role='sub_admin' AND EXISTS (SELECT 1 FROM user_sites us WHERE us.user_id=${alias}.id AND us.site_id=${site})))`;
// The Admin's aligned wallet holds a site's cash custody ($1 site, $2 organisation).
const ALIGNED_WALLET_SQL = `SELECT p.holder_key, (SELECT COALESCE(sum(e.amount),0) FROM loyalty_vault_entries e
    WHERE e.organization_id=p.organization_id AND e.holder_key=p.holder_key AND e.site_id=p.site_id) AS balance
  FROM loyalty_vault_site_accounts p JOIN users u ON p.holder_type='user' AND u.id=p.holder_id AND u.role='admin'
  WHERE p.organization_id=$2 AND p.site_id=$1 AND p.aligned_id IS NOT NULL ORDER BY p.holder_key LIMIT 1`;
// Cash = the card's "Admin Wallet CASH" (site cash after staff imprest and
// pending handovers), capped by the wallet it leaves. Bank = posted bank.
const BALANCE_SQL = `WITH wallet AS (${ALIGNED_WALLET_SQL}), site_cash AS (SELECT imprest_financial_site_cash($1) AS amount)
  SELECT GREATEST(LEAST(c.amount, COALESCE(w.balance, c.amount)), 0)::numeric(15,2)::text AS cash,
    GREATEST((SELECT COALESCE(sum(credit-debit),0) FROM ledger_entries WHERE site_id=$1 AND bucket<>'cash'
      AND entry_date<=(now() AT TIME ZONE 'Asia/Kolkata')::date), 0)::numeric(15,2)::text AS bank
  FROM site_cash c LEFT JOIN wallet w ON true`;
const ROW_SQL = `SELECT t.id, 'SMT-' || t.id AS reference, t.status, t.amount::text AS amount, t.mode,
    to_char(t.transfer_date,'YYYY-MM-DD') AS transfer_date, to_char(t.transfer_time,'HH24:MI:SS') AS transfer_time,
    t.remarks, t.decision_note, t.created_at, t.decided_at,
    t.source_site_id, ss.name AS source_site_name, t.destination_site_id, ds.name AS destination_site_name,
    t.requested_by, ru.name AS requested_by_name, t.approver_id, au.name AS approver_name, du.name AS decided_by_name,
    sb.name AS source_bank_name, rb.name AS destination_bank_name
  FROM site_money_transfers t
  JOIN sites ss ON ss.id=t.source_site_id JOIN sites ds ON ds.id=t.destination_site_id
  LEFT JOIN users ru ON ru.id=t.requested_by LEFT JOIN users au ON au.id=t.approver_id LEFT JOIN users du ON du.id=t.decided_by
  LEFT JOIN bank_accounts sb ON sb.id=t.source_bank_account_id LEFT JOIN bank_accounts rb ON rb.id=t.destination_bank_account_id`;

const readTransfer = async (db, id) => (await db.query(`${ROW_SQL} WHERE t.id=$1`, [id])).rows[0];
const balances = async (db, siteId, org) => (await db.query(BALANCE_SQL, [siteId, org])).rows[0];

export async function transferContext(user, siteId, db = pool) {
  const actor = await actorFor(user, db);
  const id = positiveId(siteId, 'a site');
  const access = [actor.organization_id, actor.isAdmin, actor.id];
  const [sites, approvers, banks, available, dateEditable] = await Promise.all([
    db.query(`${SITES_SQL} ORDER BY lower(s.name), s.id`, access).then(r => r.rows),
    db.query(`SELECT u.id, u.name, u.role FROM users u WHERE u.id<>$2 AND ${approverRule('u', '$1', '$3')}
      ORDER BY CASE u.role WHEN 'admin' THEN 0 WHEN 'super_admin' THEN 1 ELSE 2 END, lower(u.name), u.id`,
    [actor.organization_id, actor.id, id]).then(r => r.rows),
    db.query(`SELECT b.id, b.name, b.site_id FROM bank_accounts b JOIN (${SITES_SQL}) s ON s.id=b.site_id
      WHERE b.is_active IS NOT FALSE ORDER BY b.site_id, lower(b.name)`, access).then(r => r.rows),
    balances(db, id, actor.organization_id),
    transactionDateEditable(id, db),
  ]);
  const site = sites.find(row => row.id === id);
  if (!site) throw fail('Access denied to this site', 403);
  return { site, sites: sites.filter(row => row.id !== id), approvers, banks, available,
    today: currentTransactionDate(), date_editable: dateEditable };
}

export async function createTransfer(user, body, db = pool) {
  const actor = await actorFor(user, db);
  const today = currentTransactionDate();
  const input = parseTransferRequest(body, today);
  const { rows: [check] } = await db.query(`SELECT
      (SELECT count(*) FROM (${SITES_SQL}) s WHERE s.id IN ($4,$5)) = 2 AS sites_ok,
      EXISTS (SELECT 1 FROM users u WHERE u.id=$6 AND u.id<>$3 AND ${approverRule('u', '$1', '$4')}) AS approver_ok,
      ($7::int IS NULL OR EXISTS (SELECT 1 FROM bank_accounts WHERE id=$7 AND site_id=$4)) AS source_bank_ok,
      ($8::int IS NULL OR EXISTS (SELECT 1 FROM bank_accounts WHERE id=$8 AND site_id=$5)) AS destination_bank_ok`,
  [actor.organization_id, actor.isAdmin, actor.id, input.sourceSiteId, input.destinationSiteId, input.approverId,
    input.sourceBankId, input.destinationBankId]);
  if (!check.sites_ok) throw fail('Choose sending and receiving sites you can access.', 403);
  if (!check.approver_ok) throw fail('Choose an active admin, or a sub-admin of the sending site, to approve.');
  if (!check.source_bank_ok || !check.destination_bank_ok) throw fail('Each bank account must belong to its own site.');
  if (input.date !== today && !(await transactionDateEditable(input.sourceSiteId, db))) throw fail('This site records transfers on today’s date only.');
  const available = (await balances(db, input.sourceSiteId, actor.organization_id))[input.mode];
  if (moneyMinor(input.amount) > moneyMinor(available)) {
    throw fail(`Only ${inr(available)} ${input.mode} is available in the sending site.`, 409, 'INSUFFICIENT_SITE_BALANCE');
  }
  const { rows: [{ id }] } = await db.query(`INSERT INTO site_money_transfers(organization_id, source_site_id, destination_site_id, amount, mode,
      source_bank_account_id, destination_bank_account_id, transfer_date, transfer_time, remarks, requested_by, approver_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
  [actor.organization_id, input.sourceSiteId, input.destinationSiteId, input.amount, input.mode, input.sourceBankId,
    input.destinationBankId, input.date, input.time, input.remarks, actor.id, input.approverId]);
  return readTransfer(db, id);
}

/** The bell: pending requests waiting on me, and my last 20 requests. */
export async function transferInbox(user, db = pool) {
  const actor = await actorFor(user, db);
  const { rows } = await db.query(`${ROW_SQL} WHERE t.organization_id=$1 AND ((t.approver_id=$2 AND t.status='pending')
      OR t.id IN (SELECT id FROM site_money_transfers WHERE requested_by=$2 ORDER BY created_at DESC LIMIT 20))
    ORDER BY t.created_at DESC`, [actor.organization_id, actor.id]);
  return {
    received: rows.filter(row => row.approver_id === actor.id),
    sent: rows.filter(row => row.requested_by === actor.id),
  };
}

export async function approveTransfer(user, id, database = pool) {
  const transferId = positiveId(id, 'a transfer');
  return transaction(database, async db => {
    const actor = await actorFor(user, db);
    const org = actor.organization_id;
    const { rows: [t] } = await db.query(`SELECT t.id, t.status, t.approver_id, t.amount::text AS amount, t.mode,
        t.source_site_id, t.destination_site_id, ss.name AS source_name, ds.name AS destination_name
      FROM site_money_transfers t JOIN sites ss ON ss.id=t.source_site_id JOIN sites ds ON ds.id=t.destination_site_id
      WHERE t.id=$1 AND t.organization_id=$2 FOR UPDATE OF t`, [transferId, org]);
    if (!t) throw fail('Transfer request not found.', 404);
    if (t.approver_id !== actor.id) throw fail('Only the chosen approver can decide this transfer.', 403);
    if (t.status !== 'pending') throw fail(`This transfer was already ${t.status}.`, 409);
    const { rows: [eligible] } = await db.query(`SELECT EXISTS (SELECT 1 FROM users u WHERE u.id=$1 AND ${approverRule('u', '$2', '$3')}) AS ok`,
      [actor.id, org, t.source_site_id]);
    if (!eligible.ok) throw fail('You can no longer approve transfers from this site.', 403);

    // Same per-site lock as every imprest and ledger writer, in a fixed order.
    for (const site of [t.source_site_id, t.destination_site_id].sort((a, b) => a - b)) {
      await db.query("SELECT pg_advisory_xact_lock(hashtext('imprest-site-' || $1::text))", [site]);
    }
    const available = (await balances(db, t.source_site_id, org))[t.mode];
    if (moneyMinor(t.amount) > moneyMinor(available)) {
      throw fail(`${t.source_name} now has only ${inr(available)} ${t.mode} available. Ask for a smaller transfer.`, 409, 'INSUFFICIENT_SITE_BALANCE');
    }
    const { rows: [month] } = await db.query(`SELECT ensure_site_cashflow_month(t.source_site_id, t.transfer_date, t.requested_by) AS source,
        ensure_site_cashflow_month(t.destination_site_id, t.transfer_date, t.requested_by) AS destination
      FROM site_money_transfers t WHERE t.id=$1`, [t.id]);
    const { rows: locked } = await db.query('SELECT 1 FROM cash_flow_months WHERE id IN ($1,$2) AND is_locked', [month.source, month.destination]);
    if (locked.length) throw fail('The accounting period for this transfer date is locked in one of the sites.', 409);

    const { rows: legs } = await db.query(`INSERT INTO cash_flow_entries(cash_flow_month_id, site_id, date, transaction_time, particular,
        debit, credit, cash_type, remarks, to_name, bank_account_id, created_by, status, approved_by, approved_at, assigned_admin_id,
        source_module, source_id, site_transfer_id, site_transfer_leg)
      SELECT leg.month_id, leg.site_id, t.transfer_date, t.transfer_time, left(leg.particular, 250), leg.debit, leg.credit, t.mode,
        NULLIF(t.remarks, ''), left(leg.other_site, 200), leg.bank_id, t.requested_by, 'approved', $2, now(), $2,
        'cashflow_transfers', NULL, t.id, leg.leg
      FROM site_money_transfers t JOIN sites ss ON ss.id=t.source_site_id JOIN sites ds ON ds.id=t.destination_site_id
      CROSS JOIN LATERAL (VALUES
        ('debit', $3::int, t.source_site_id, 'SITE TRANSFER TO ' || ds.name || ' · SMT-' || t.id, t.amount, 0::numeric, ds.name, t.source_bank_account_id),
        ('credit', $4::int, t.destination_site_id, 'SITE TRANSFER FROM ' || ss.name || ' · SMT-' || t.id, 0::numeric, t.amount, ss.name, t.destination_bank_account_id)
      ) AS leg(leg, month_id, site_id, particular, debit, credit, other_site, bank_id)
      WHERE t.id=$1 RETURNING id, site_transfer_leg`, [t.id, actor.id, month.source, month.destination]);
    if (legs.length !== 2) throw fail('The transfer entries could not be posted.', 500);

    // Cash custody leaves the sending Admin wallet and arrives in the receiving
    // one, so each card's wallet rows still add up to its Cash.
    if (t.mode === 'cash') {
      const details = JSON.stringify({ site_transfer_id: t.id, reference: reference(t.id), source_site_id: t.source_site_id,
        destination_site_id: t.destination_site_id, payment_mode: 'CASH' });
      for (const [site, sign, kind, text] of [
        [t.source_site_id, '-', 'transfer_out', `Site transfer ${reference(t.id)} to ${t.destination_name}`],
        [t.destination_site_id, '', 'transfer_in', `Site transfer ${reference(t.id)} from ${t.source_name}`],
      ]) {
        const wallet = (await db.query(ALIGNED_WALLET_SQL, [site, org])).rows[0];
        if (wallet) await db.query(`SELECT loyalty_vault_apply_delta($1,$2,${sign}$3::numeric,$4,$5,'site_money_transfers',$6,NULL,$7,$8,NULL,$9::jsonb)`,
          [wallet.holder_key, org, t.amount, kind, text, t.id, site, actor.id, details]);
      }
    }
    await db.query("UPDATE site_money_transfers SET status='approved', decided_by=$2, decided_at=now() WHERE id=$1", [t.id, actor.id]);
    await db.query('SET CONSTRAINTS ALL IMMEDIATE');
    return readTransfer(db, t.id);
  });
}

/** reject: the approver says no. cancel: the requester withdraws. Both only while pending. */
export async function closeTransfer(user, id, action, note, db = pool) {
  const actor = await actorFor(user, db);
  const transferId = positiveId(id, 'a transfer');
  const rejecting = action === 'reject';
  const text = typeof note === 'string' ? note.trim().slice(0, 500) : '';
  const { rows } = await db.query(`UPDATE site_money_transfers SET status=$4, decided_by=$2, decided_at=now(), decision_note=NULLIF($5,'')
    WHERE id=$1 AND organization_id=$3 AND status='pending' AND ${rejecting ? 'approver_id' : 'requested_by'}=$2 RETURNING id`,
  [transferId, actor.id, actor.organization_id, rejecting ? 'rejected' : 'cancelled', text]);
  if (!rows.length) {
    const { rows: [existing] } = await db.query('SELECT status FROM site_money_transfers WHERE id=$1 AND organization_id=$2',
      [transferId, actor.organization_id]);
    if (!existing) throw fail('Transfer request not found.', 404);
    if (existing.status !== 'pending') throw fail(`This transfer was already ${existing.status}.`, 409);
    throw fail(rejecting ? 'Only the chosen approver can reject this transfer.' : 'Only the requester can cancel this transfer.', 403);
  }
  return readTransfer(db, transferId);
}
