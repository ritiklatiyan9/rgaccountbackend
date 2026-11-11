import { createHash } from 'node:crypto';
// Percentage values always refer to the property's commission pool. All money
// arithmetic stays in integer paise; largest remainders conserve a full split.
const fail = (message, statusCode = 400, code = 'INVALID_COMMISSION_ALLOCATION') => {
  throw Object.assign(new Error(message), { statusCode, code });
};
export const positiveId = value => {
  const text = String(value ?? '');
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(Number(text)) || Number(text) < 1 || Number(text) > 2147483647) fail('A valid record ID is required');
  return Number(text);
};
const decimalUnits = (value, precision, label) => {
  const text = String(value ?? '').trim();
  const pattern = new RegExp(`^\\d+(?:\\.\\d{1,${precision}})?$`);
  if (!pattern.test(text)) fail(`${label} must be a positive number with at most ${precision} decimal places`);
  const [whole, fraction = ''] = text.split('.');
  const units = BigInt(whole) * (10n ** BigInt(precision)) + BigInt(fraction.padEnd(precision, '0'));
  if (units <= 0n || units > 999999999999n * (10n ** BigInt(Math.max(precision - 2, 0)))) fail(`${label} is outside the supported range`);
  return units;
};
const asMoney = cents => Number(cents) / 100;
export function calculateCommissionAllocations(total, allocations) {
  const pool = decimalUnits(total, 2, 'Total commission');
  if (!Array.isArray(allocations)) fail('allocations must be a list');
  const ids = new Set();
  const denominator = 100000000n;
  let numeratorTotal = 0n;
  const rows = allocations.map((row, index) => {
    const agent_id = positiveId(row?.agent_id);
    if (ids.has(agent_id)) fail('Select each dealer only once');
    ids.add(agent_id);
    const allocation_type = row.allocation_type;
    if (!['percentage', 'amount'].includes(allocation_type)) fail('Choose percentage or rupee commission for every dealer');
    const units = decimalUnits(row.allocation_value, allocation_type === 'percentage' ? 6 : 2, 'Dealer commission');
    if (allocation_type === 'percentage' && units > denominator) fail('A percentage cannot exceed 100');
    const numerator = allocation_type === 'percentage' ? pool * units : units * denominator;
    numeratorTotal += numerator;
    if (row.remarks != null && (typeof row.remarks !== 'string' || row.remarks.length > 5000)) fail('Dealer remarks must be at most 5000 characters');
    return { agent_id, allocation_type, allocation_value: Number(units) / (allocation_type === 'percentage' ? 1000000 : 100),
      allocation_base: asMoney(pool), remarks: row.remarks?.trim() || null, cents: numerator / denominator,
      remainder: numerator % denominator, index };
  });
  if (numeratorTotal > pool * denominator) fail('Dealer commissions exceed the total commission pool', 400, 'COMMISSION_OVERALLOCATED');
  const target = (numeratorTotal + denominator / 2n) / denominator;
  let remaining = target - rows.reduce((sum, row) => sum + row.cents, 0n);
  for (const row of [...rows].sort((a, b) => a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1)) {
    if (remaining <= 0n) break;
    row.cents += 1n;
    remaining -= 1n;
  }
  if (rows.some(row => row.cents < 1n)) fail('Every dealer commission must be at least ₹0.01 after rounding');
  return { total_commission: asMoney(pool), allocated_commission: asMoney(target), unallocated_commission: asMoney(pool - target),
    allocations: rows.map(({ cents, remainder, index, ...row }) => ({ ...row, total_commission: asMoney(cents) })) };
}

export function commissionAllocationRevision(plot, masters) {
  return createHash('sha256').update(JSON.stringify({pool:Number(plot.plot_commission)||0,
    rows:[...masters].sort((a,b)=>Number(a.id ?? a.commission_id)-Number(b.id ?? b.commission_id)).map(row=>[
      Number(row.id ?? row.commission_id),Number(row.agent_id),Number(row.total_commission),row.allocation_type||null,
      row.allocation_value==null?null:Number(row.allocation_value),row.allocation_base==null?null:Number(row.allocation_base),
      row.remarks||null,(row.updated_at ?? row.revision_updated_at)==null?null:new Date(row.updated_at ?? row.revision_updated_at).toISOString(),
    ])})).digest('hex');
}

export async function assertAllocationSite(db, user, siteId) {
  const { rows } = await db.query(`SELECT s.id FROM sites s WHERE s.id=$1 AND s.organization_id=$2
    AND ($3::boolean OR EXISTS(SELECT 1 FROM user_sites us WHERE us.site_id=s.id AND us.user_id=$4))`,
  [siteId, user.organization_id, ['admin', 'super_admin'].includes(user.role), user.id]);
  if (!rows.length) fail('Site not found or unavailable', 403, 'COMMISSION_SITE_ACCESS');
}

export async function replaceCommissionAllocations(db, user, body, { canUpdate = true } = {}) {
  const siteId = positiveId(body.site_id), plotId = positiveId(body.plot_id);
  const plan = calculateCommissionAllocations(body.total_commission, body.allocations);
  if (typeof body.revision !== 'string' || !/^[a-f0-9]{64}$/.test(body.revision)) fail('Refresh the dealer breakdown before saving.',409,'COMMISSION_ALLOCATION_CONFLICT');
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '5s'");
    await assertAllocationSite(client, user, siteId);
    const plot = (await client.query(`SELECT id,plot_commission,to_jsonb(plots)->>'booking_cancelled_at' AS booking_cancelled_at FROM plots WHERE id=$1 AND site_id=$2 FOR UPDATE`, [plotId, siteId])).rows[0];
    if (!plot) fail('Plot or shop not found on this site', 404);
    if (plot.booking_cancelled_at) fail('Cancelled booking allocations are preserved. Use their original ledger for payouts or recoveries.',409,'BOOKING_HISTORY_IMMUTABLE');
    const { rows: existing } = await client.query('SELECT * FROM plot_commissions_v2 WHERE plot_id=$1 AND site_id=$2 ORDER BY id FOR UPDATE', [plotId, siteId]);
    if (commissionAllocationRevision(plot,existing)!==body.revision) fail('The dealer breakdown changed while you were editing. Refresh it and apply your changes again.',409,'COMMISSION_ALLOCATION_CONFLICT');
    if (existing.length && !canUpdate) fail('Updating existing dealer commissions requires update permission', 403, 'COMMISSION_UPDATE_PERMISSION');
    const oldByAgent = new Map();
    for (const row of existing) {
      if (oldByAgent.has(Number(row.agent_id))) fail('This property has duplicate dealer records. Resolve them before splitting its commission.', 409);
      oldByAgent.set(Number(row.agent_id), row);
    }
    const agentIds = plan.allocations.map(row => row.agent_id);
    if (agentIds.length) {
      const { rows: valid } = await client.query(`SELECT m.id FROM members m JOIN sites s ON s.id=m.site_id
        WHERE m.id=ANY($1::int[]) AND s.organization_id=$2`, [agentIds, user.organization_id]);
      if (valid.length !== agentIds.length) fail('A selected dealer is unavailable in this organization', 400);
    }
    const { rows: obligations } = await client.query(`SELECT p.plot_commission_id, COUNT(*)::int AS payment_count,
      COALESCE(SUM(CASE WHEN p.amount>=0 OR financial_transaction_posts('credit',p.status,p.payment_mode,p.cheque_status)
        THEN p.amount + COALESCE(p.tds_amount,0) ELSE 0 END) FILTER (WHERE LOWER(COALESCE(NULLIF(TRIM(p.status),''),'approved')) NOT IN ('rejected','cancelled','canceled','deleted','void','voided')
        AND UPPER(TRIM(COALESCE(p.cheque_status,''))) NOT IN ('BOUNCED','RETURNED')),0) AS committed
      FROM plot_commission_payments p WHERE p.plot_commission_id=ANY($1::int[]) GROUP BY p.plot_commission_id`, [existing.map(row => row.id)]);
    const byId = new Map(obligations.map(row => [Number(row.plot_commission_id), row]));
    const plannedByAgent = new Map(plan.allocations.map(row => [row.agent_id, row]));
    for (const old of existing) {
      const allocation = plannedByAgent.get(Number(old.agent_id));
      const obligation = byId.get(Number(old.id));
      if (!allocation && obligation?.payment_count > 0) fail('A dealer with payment history cannot be removed. Keep that dealer in the breakdown.', 409, 'COMMISSION_HAS_PAYMENTS');
      if (allocation && Math.round(allocation.total_commission * 100) < Math.round(Number(obligation?.committed || 0) * 100)) {
        fail('A dealer commission cannot be lower than their paid and pending commissions.', 409, 'COMMISSION_BELOW_COMMITTED');
      }
    }
    await client.query('DELETE FROM plot_commissions_v2 WHERE plot_id=$1 AND site_id=$2 AND NOT (agent_id=ANY($3::int[]))', [plotId, siteId, agentIds]);
    await client.query('UPDATE plots SET plot_commission=$1,updated_at=NOW() WHERE id=$2 AND site_id=$3', [plan.total_commission, plotId, siteId]);
    // One set-based UPDATE and INSERT, regardless of the number of dealers.
    const { rows: masters } = await client.query(`WITH input AS (
      SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(agent_id int,total_commission numeric,allocation_type text,allocation_value numeric,allocation_base numeric,remarks text)
    ), updated AS (
      UPDATE plot_commissions_v2 pc SET total_commission=x.total_commission,allocation_type=x.allocation_type,
        allocation_value=x.allocation_value,allocation_base=x.allocation_base,remarks=x.remarks,updated_at=NOW(),
        status=CASE WHEN COALESCE((SELECT SUM(p.amount+COALESCE(p.tds_amount,0)) FROM plot_commission_payments p
          WHERE p.plot_commission_id=pc.id AND financial_transaction_posts(CASE WHEN p.amount<0 THEN 'credit' ELSE 'debit' END,p.status,p.payment_mode,p.cheque_status)),0)>=x.total_commission THEN 'Completed'
          WHEN EXISTS(SELECT 1 FROM plot_commission_payments p WHERE p.plot_commission_id=pc.id AND financial_transaction_posts(CASE WHEN p.amount<0 THEN 'credit' ELSE 'debit' END,p.status,p.payment_mode,p.cheque_status)) THEN 'Partial' ELSE 'Pending' END
      FROM input x WHERE pc.plot_id=$2 AND pc.site_id=$3 AND pc.agent_id=x.agent_id RETURNING pc.*
    ), inserted AS (
      INSERT INTO plot_commissions_v2(site_id,plot_id,agent_id,total_commission,allocation_type,allocation_value,allocation_base,remarks,status,created_by)
      SELECT $3,$2,x.agent_id,x.total_commission,x.allocation_type,x.allocation_value,x.allocation_base,x.remarks,'Pending',$4
        FROM input x WHERE NOT EXISTS(SELECT 1 FROM plot_commissions_v2 pc WHERE pc.plot_id=$2 AND pc.site_id=$3 AND pc.agent_id=x.agent_id)
      RETURNING *
    ) SELECT * FROM updated UNION ALL SELECT * FROM inserted`, [JSON.stringify(plan.allocations), plotId, siteId, user.id]);
    await client.query('COMMIT');
    return { ...plan, allocations: undefined, masters };
  } catch (error) {
    await client.query('ROLLBACK');
    if (error.code === '42703') fail('Commission splitting needs the latest database setup. Restart the API after applying migration 241.', 503, 'COMMISSION_ALLOCATIONS_NOT_READY');
    throw error;
  } finally { client.release(); }
}
