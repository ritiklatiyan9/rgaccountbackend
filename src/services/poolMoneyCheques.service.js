// Show existing Booking Software cheques before their explicit import into
// Accounts. These are collection records, not matcher candidates or postings.
export async function loadUnrecordedPoolCollections(db, organizationId, siteId, { modes = ['CHEQUE'], status = 'PENDING' } = {}) {
  const { rows: [schema] } = await db.query(`SELECT
    to_regclass('public.bookings') IS NOT NULL AS bookings,
    to_regclass('public.draw_payments') IS NOT NULL AND to_regclass('public.draw_registrations') IS NOT NULL AS draws,
    to_regclass('public.pool_money_receipts') IS NOT NULL AS recorded`);
  const sources = [];
  if (schema.draws) sources.push(`SELECT 'draw'::text AS kind, r.id AS owner_id, dp.id AS source_id,
    r.registration_no AS reference, dp.receipt_no, m.full_name AS customer_name,
    to_char(dp.payment_date,'YYYY-MM-DD') AS date, dp.amount, dp.cheque_no, dp.bank_name, upper(dp.payment_from) AS payment_from, NULLIF(to_jsonb(dp)->>'bank_account_id','')::integer AS bank_account_id,
    r.status AS registration_status,
    upper(COALESCE(NULLIF(to_jsonb(dp)->>'cheque_status',''),'PENDING')) AS cheque_status
    FROM draw_payments dp JOIN draw_registrations r ON r.id=dp.draw_registration_id
    JOIN sites s ON s.id=r.site_id AND s.organization_id=$1
    LEFT JOIN members m ON m.id=r.client_member_id
    WHERE r.site_id=$2 AND upper(dp.payment_from)=ANY($4::text[]) AND dp.amount>0
      AND NULLIF(to_jsonb(dp)->>'plot_payment_id','') IS NULL
      ${schema.recorded ? "AND NOT EXISTS(SELECT 1 FROM pool_money_receipts recorded WHERE recorded.source_kind='draw' AND recorded.source_id=dp.id)" : ''}`);
  if (schema.bookings) sources.push(`SELECT 'booking'::text AS kind, b.id AS owner_id, b.id AS source_id,
    b.booking_no AS reference, b.booking_no AS receipt_no, COALESCE(m.full_name,b.buyer_name) AS customer_name,
    to_char(COALESCE(NULLIF(to_jsonb(b)->>'token_payment_date','')::date,b.booking_date),'YYYY-MM-DD') AS date,
    b.token_amount AS amount,to_jsonb(b)->>'token_cheque_no' AS cheque_no,to_jsonb(b)->>'token_bank_name' AS bank_name,
    upper(to_jsonb(b)->>'token_payment_from') AS payment_from,NULLIF(to_jsonb(b)->>'bank_account_id','')::integer AS bank_account_id,
    b.status AS registration_status,
    upper(COALESCE(NULLIF(to_jsonb(b)->>'token_cheque_status',''),'PENDING')) AS cheque_status
    FROM bookings b JOIN sites s ON s.id=b.site_id AND s.organization_id=$1
    LEFT JOIN members m ON m.id=b.client_member_id
    WHERE b.site_id=$2 AND b.plot_id IS NULL AND b.token_amount>0
      AND upper(to_jsonb(b)->>'token_payment_from')=ANY($4::text[])
      AND NULLIF(to_jsonb(b)->>'token_payment_id','') IS NULL
      ${schema.draws ? 'AND NOT EXISTS(SELECT 1 FROM draw_registrations linked WHERE linked.booking_id=b.id)' : ''}
      ${schema.recorded ? "AND NOT EXISTS(SELECT 1 FROM pool_money_receipts recorded WHERE recorded.source_kind='booking' AND recorded.source_id=b.id)" : ''}`);
  if (!sources.length) return [];
  const result = await db.query(`SELECT * FROM (${sources.join(' UNION ALL ')}) collections
    WHERE ($3::text IS NULL OR cheque_status=$3) ORDER BY date,kind,source_id`,
  [organizationId, siteId, status == null ? null : String(status).toUpperCase(), modes]);
  return result.rows.map(row => ({ ...row,
    id: `${row.kind}:${row.source_id}`, owner_id: Number(row.owner_id), source_id: Number(row.source_id),
    amount: String(row.amount), recorded: false,
  }));
}

export const loadUnrecordedPoolCheques = (db, organizationId, siteId, status = 'PENDING') =>
  loadUnrecordedPoolCollections(db, organizationId, siteId, { status });
