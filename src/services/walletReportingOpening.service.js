import {siteVaultAccountsCte} from './loyaltyVaultSite.service.js';
import {adminWalletCashStates} from './adminWalletCash.service.js';

const prefix = 'wallet_reporting_opening:';
const validMoney = value => /^-?\d+(?:\.\d{1,2})?$/.test(String(value ?? ''));
export const validWalletReportingOpening = row => row?.version === 1 && row.holder_type === 'user'
  && [row.organization_id,row.site_id,row.holder_id].every(value=>Number.isSafeInteger(value)&&value>0)
  && ['opening_cash','received_at_start','handovers_at_start','adjustments_at_start','recorded_balance_at_start'].every(key=>validMoney(row[key]))
  && typeof row.operation_key === 'string' && !!row.operation_key && Number.isFinite(Date.parse(row.started_at));

export async function readWalletReportingOpenings(organizationId,siteId,database) {
  const {rows}=await database.query(`SELECT a.setting_value FROM application_settings a
    JOIN sites s ON s.id=a.site_id WHERE s.organization_id=$1 AND a.site_id=$2
    AND a.setting_key LIKE 'wallet_reporting_opening:%' ORDER BY a.setting_key`,[organizationId,siteId]);
  return rows.map(row=>row.setting_value).filter(row=>validWalletReportingOpening(row)
    && row.organization_id===Number(organizationId)&&row.site_id===Number(siteId));
}

// Call inside a repeatable-read transaction. This captures report counters;
// it never adjusts wallet postings, financial source records or cached funds.
export async function planWalletReportingOpening(database,{organizationId,siteId,holderId,operationKey}) {
  if(![organizationId,siteId,holderId].every(value=>Number.isSafeInteger(value)&&value>0)
    || !/^[a-zA-Z0-9_-]{8,120}$/.test(operationKey || '')) throw new Error('Explicit opening scope and operation key are required.');
  const user=(await database.query(`SELECT u.id,u.name,u.role,s.name AS site_name FROM users u JOIN sites s ON s.id=$2
    WHERE u.id=$1 AND u.organization_id=$3 AND s.organization_id=$3 AND u.is_active=true AND u.role='admin'`,[holderId,siteId,organizationId])).rows[0];
  if(!user) throw new Error('The active Admin and site must belong to the selected organization.');
  const prior=(await readWalletReportingOpenings(organizationId,siteId,database)).find(row=>row.holder_id===holderId);
  if(prior) return {prior,user,replayed:true};
  const {rows}=await database.query(`WITH ${siteVaultAccountsCte('$1','$2')}
    SELECT total_received::text,total_handover::text,total_adjustments::text,balance::text
    FROM site_accounts WHERE holder_key=$3`,[organizationId,siteId,`user:${holderId}`]);
  const totals=rows[0];
  const cash=(await adminWalletCashStates(organizationId,siteId,database)).get(`user:${holderId}`);
  if(!totals || !cash || Number(cash.balance)<0) throw new Error('A nonnegative reconciled Admin wallet is required.');
  const clock=(await database.query('SELECT now() AS started_at')).rows[0];
  const fingerprint=(await database.query(`SELECT count(*)::int AS count,md5(string_agg(to_jsonb(e)::text,'|' ORDER BY id)) AS hash
    FROM loyalty_vault_entries e WHERE organization_id=$1 AND site_id=$2`,[organizationId,siteId])).rows[0];
  const opening={version:1,organization_id:organizationId,site_id:siteId,holder_type:'user',holder_id:holderId,
    opening_cash:cash.balance,received_at_start:totals.total_received,handovers_at_start:totals.total_handover,
    adjustments_at_start:totals.total_adjustments,recorded_balance_at_start:totals.balance,
    started_at:new Date(clock.started_at).toISOString(),operation_key:operationKey,
    basis:'Wallet report opening from current accounted cash; historical postings unchanged'};
  if(!validWalletReportingOpening(opening)) throw new Error('The opening snapshot is invalid.');
  return {opening,user,cash,fingerprint,replayed:false};
}

export async function saveWalletReportingOpening(database,plan,{actorId,writeSnapshot}) {
  if(plan.replayed) return {opening:plan.prior,replayed:true};
  if(!Number.isSafeInteger(actorId)||typeof writeSnapshot!=='function') throw new Error('An actor and durable before-snapshot are required.');
  const actor=(await database.query('SELECT id FROM users WHERE id=$1 AND organization_id=$2 AND role=\'admin\' AND is_active=true',[actorId,plan.opening.organization_id])).rows[0];
  if(!actor) throw new Error('An active Admin actor is required.');
  await writeSnapshot(plan);
  const {rows}=await database.query(`INSERT INTO application_settings(site_id,setting_key,setting_value,updated_by,updated_at)
    VALUES($1,$2,$3::jsonb,$4,now()) ON CONFLICT(site_id,setting_key) DO NOTHING RETURNING setting_value`,
    [plan.opening.site_id,`${prefix}user:${plan.opening.holder_id}`,JSON.stringify(plan.opening),actorId]);
  if(!rows.length) throw new Error('An opening already exists; do not reset it again.');
  const after=(await database.query(`SELECT count(*)::int AS count,md5(string_agg(to_jsonb(e)::text,'|' ORDER BY id)) AS hash
    FROM loyalty_vault_entries e WHERE organization_id=$1 AND site_id=$2`,[plan.opening.organization_id,plan.opening.site_id])).rows[0];
  if(JSON.stringify(after)!==JSON.stringify(plan.fingerprint)) throw new Error('Wallet history changed while saving the report opening.');
  return {opening:rows[0].setting_value,replayed:false,financial_postings_unchanged:true,wallet_fingerprint:after};
}
