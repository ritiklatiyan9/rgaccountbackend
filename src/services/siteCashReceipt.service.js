import pool from '../config/db.js';
import { actorFor, ledgerReason, ledgerRows, transferError } from './cashflowTransfer.service.js';

function positiveId(value) {
  const id = Number(value);
  if (!/^\d+$/.test(String(value)) || !Number.isSafeInteger(id) || id <= 0 || id > 2147483647) {
    throw transferError('INVALID_ID', 'Select a valid site or ledger.');
  }
  return id;
}

export async function siteCashReceiptContext(user, ledgerId, db = pool) {
  const actor = await actorFor(user, db);
  const [destination] = await ledgerRows(db, actor, [positiveId(ledgerId)]);
  if (!destination) throw transferError('LEDGER_NOT_FOUND', 'The receiving ledger is unavailable.', 404);
  const reason = ledgerReason(destination);
  if (reason) throw transferError('LEDGER_UNAVAILABLE', reason, 409);
  const { rows: [sourceSite] } = await db.query(`SELECT s.id,s.name FROM cash_flow_months d
    JOIN sites s ON s.id=d.cash_receipt_source_site_id
    WHERE d.id=$1 AND s.organization_id=$2 AND ($3::boolean OR EXISTS
      (SELECT 1 FROM user_sites us WHERE us.user_id=$4 AND us.site_id=s.id))`,
  [destination.id, actor.organization_id, actor.is_admin, actor.id]);
  if (!sourceSite) throw transferError('RECEIPT_SOURCE_UNAVAILABLE', 'The sending site is unavailable to your account.', 403);
  const { rows: ledgers } = await db.query(`SELECT id,ledger_name,month,year FROM (
    SELECT DISTINCT ON (ledger_name) id,ledger_name,month,year,is_locked FROM cash_flow_months
    WHERE site_id=$1 AND ledger_type='person' ORDER BY ledger_name,year DESC,month DESC,id DESC
  ) latest WHERE NOT COALESCE(is_locked,false) AND (year,month)<=
    (EXTRACT(YEAR FROM now() AT TIME ZONE 'Asia/Kolkata'),EXTRACT(MONTH FROM now() AT TIME ZONE 'Asia/Kolkata')) ORDER BY ledger_name,id`, [sourceSite.id]);
  return { source_site: sourceSite, source_ledgers: ledgers, destination };
}

// A debit is visible in its sending site. Restricted ledger readers see their own transfers.
const visibleNotices = `FROM cashflow_site_debit_notices n
  JOIN sites s ON s.id=n.site_id JOIN users u ON u.id=$2 AND u.is_active AND u.organization_id=s.organization_id
  LEFT JOIN user_permissions p ON p.user_id=u.id AND p.module='cashflow'
  WHERE n.site_id=$1 AND (u.role IN ('admin','super_admin') OR
    (u.role='sub_admin' AND p.can_read AND (p.can_view_all OR n.initiated_by=u.id) AND EXISTS
      (SELECT 1 FROM user_sites us WHERE us.user_id=u.id AND us.site_id=s.id)))`;

export async function unreadSiteDebits(user, siteId, db = pool) {
  const { rows } = await db.query(`WITH unread AS (SELECT n.* ${visibleNotices}
    AND NOT EXISTS (SELECT 1 FROM cashflow_site_debit_notice_reads r WHERE r.user_id=$2 AND r.transfer_id=n.transfer_id))
    SELECT n.transfer_id,n.site_id,n.source_ledger_id,n.amount::text,n.reference,n.created_at,
      d.name AS destination_site_name,COUNT(*) OVER()::int AS total
    FROM unread n JOIN sites d ON d.id=n.destination_site_id ORDER BY n.created_at DESC,n.transfer_id LIMIT 25`,
  [positiveId(siteId), user.id]);
  return { notices: rows, unread_count: rows[0]?.total || 0 };
}

export async function readSiteDebit(user, siteId, transferId, db = pool) {
  if (!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(transferId)) throw transferError('INVALID_ID', 'Select a valid debit notification.');
  await db.query(`INSERT INTO cashflow_site_debit_notice_reads(transfer_id,user_id)
    SELECT n.transfer_id,u.id ${visibleNotices} AND n.transfer_id=$3 ON CONFLICT DO NOTHING`, [positiveId(siteId), user.id, transferId]);
}
