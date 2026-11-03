import { pagination, historyDate, positiveId, walletError } from './wallet.service.js';
import { visibleImprestPeople } from './imprestManagementAccess.service.js';

const ADMIN_ROLES = new Set(['admin', 'super_admin']);

// Read the owning handover once, rather than summing both sides of its ledger
// or treating expense reversals, returns and balance adjustments as giving.
export const confirmedImprestHandoversSql = `WITH handovers AS (
  SELECT 'allocation:'||a.id::text AS id,'Allocation'::text AS source,a.admin_id AS from_user_id,
    a.sub_admin_id AS to_user_id,a.amount,COALESCE(a.confirmed_at,a.created_at) AS confirmed_at,a.remark AS note
  FROM imprest_allocations a WHERE a.site_id=$2 AND a.status='RECEIVED' AND a.amount>0
  UNION ALL
  SELECT 'transfer:'||t.id::text,'Imprest transfer',t.from_user_id,t.to_user_id,t.amount,t.created_at,t.remark
  FROM imprest_transfers t WHERE t.site_id=$2 AND t.amount>0
  UNION ALL
  SELECT 'wallet:'||w.id::text,'Wallet → Imprest',w.from_user_id,w.to_user_id,w.amount,
    COALESCE(w.resolved_at,GREATEST(w.sender_accepted_at,w.recipient_accepted_at),w.created_at),w.note
  FROM wallet_imprest_transfers w WHERE w.site_id=$2 AND w.organization_id=$1 AND w.status='accepted' AND w.amount>0
), authorized AS (
  SELECT h.*,giver.name AS from_user_name,recipient.name AS to_user_name,
    ($3::integer[] IS NULL OR h.from_user_id=ANY($3::integer[])) AS visible_given,
    ($3::integer[] IS NULL OR h.to_user_id=ANY($3::integer[])) AS visible_received
  FROM handovers h JOIN users giver ON giver.id=h.from_user_id AND giver.organization_id=$1
    JOIN users recipient ON recipient.id=h.to_user_id AND recipient.organization_id=$1
  WHERE ($3::integer[] IS NULL OR h.from_user_id=ANY($3::integer[]) OR h.to_user_id=ANY($3::integer[]))
), filtered AS (
  SELECT a.* FROM authorized a
  WHERE ($5::date IS NULL OR a.confirmed_at>=($5::date::timestamp AT TIME ZONE 'Asia/Kolkata'))
    AND a.confirmed_at<((LEAST(COALESCE($6::date,(now() AT TIME ZONE 'Asia/Kolkata')::date),(now() AT TIME ZONE 'Asia/Kolkata')::date)+1)::timestamp AT TIME ZONE 'Asia/Kolkata')
), person_totals AS (
  SELECT user_id,sum(given)::text AS total_given,sum(received)::text AS total_received,
    sum(given_count)::integer AS given_count,sum(received_count)::integer AS received_count
  FROM (
    SELECT from_user_id AS user_id,amount AS given,0::numeric AS received,1 AS given_count,0 AS received_count FROM filtered WHERE visible_given
    UNION ALL
    SELECT to_user_id,0::numeric,amount,0,1 FROM filtered WHERE visible_received
  ) movements GROUP BY user_id
), selected AS (
  SELECT a.*,a.visible_given AND ($4::integer IS NULL OR a.from_user_id=$4) AS counts_given,
    a.visible_received AND ($4::integer IS NULL OR a.to_user_id=$4) AS counts_received
  FROM filtered a
  WHERE ($4::integer IS NULL OR $4 IN(a.from_user_id,a.to_user_id))
), listed AS (
  SELECT * FROM selected WHERE $9::text='all' OR ($9='given' AND counts_given) OR ($9='received' AND counts_received)
), paged AS (
  SELECT id,source,from_user_id,to_user_id,from_user_name,to_user_name,amount::text,confirmed_at,note,counts_given,counts_received
  FROM listed ORDER BY confirmed_at DESC,id DESC LIMIT $7 OFFSET $8
)
SELECT COALESCE(sum(amount) FILTER(WHERE counts_given),0)::text AS total_given,
  COALESCE(sum(amount) FILTER(WHERE counts_received),0)::text AS total_received,
  count(*) FILTER(WHERE counts_given)::integer AS given_count,
  count(*) FILTER(WHERE counts_received)::integer AS received_count,(SELECT count(*)::integer FROM listed) AS total,
  COALESCE((SELECT jsonb_agg(to_jsonb(p)) FROM person_totals p),'[]'::jsonb) AS people_totals,
  COALESCE((SELECT jsonb_agg(to_jsonb(p) ORDER BY p.confirmed_at DESC,p.id DESC) FROM paged p),'[]'::jsonb) AS entries
FROM selected`;

export async function getImprestHandoverSummary(db, { actor, query = {}, canReadPersonal, canManage }) {
  if (!actor?.is_active || !['admin','super_admin','sub_admin'].includes(actor.role)) throw walletError('Imprest access is required.',403);
  const admin=ADMIN_ROLES.has(actor.role),management=query.scope==='management';
  if (query.scope!=null && !['personal','management'].includes(query.scope)) throw walletError('Choose a valid Imprest scope.');
  if (management ? !canManage : !admin && !canReadPersonal) throw walletError('You do not have access to this Imprest view.',403);
  const siteId=positiveId(query.site_id),organizationId=Number(actor.organization_id);
  const site=(await db.query(`SELECT id FROM sites WHERE id=$1 AND organization_id=$2
    AND ($3::boolean OR EXISTS(SELECT 1 FROM user_sites WHERE user_id=$4 AND site_id=$1))`,[siteId,organizationId,admin,actor.id])).rows[0];
  if(!site) throw walletError('Choose a site you can access.',403);
  const from=query.from ? historyDate(query.from) : null,to=query.to ? historyDate(query.to) : null;
  if(from&&to&&from>to)throw walletError('Choose an end date on or after the start date.');
  const direction=query.direction||'all';
  if(!['all','given','received'].includes(direction))throw walletError('Choose a valid handover direction.');
  const visible=admin ? null : management ? await visibleImprestPeople(db,actor,siteId) : [Number(actor.id)];
  const personId=query.person_id==='all' ? null : query.person_id==null ? (admin&&management?null:Number(actor.id)) : positiveId(query.person_id);
  if(personId==null&&!admin&&!management)throw walletError('You can view only your own Imprest totals.',403);
  if(personId!=null&&visible&&!visible.includes(personId))throw walletError('You do not have access to this person’s Imprest.',403);
  const people=(await db.query(`SELECT u.id,u.name,u.photo,u.is_active FROM users u WHERE u.organization_id=$1
    AND ($3::integer[] IS NULL OR u.id=ANY($3::integer[]))
    AND ((u.is_active AND u.role IN('admin','super_admin','sub_admin') AND (u.role IN('admin','super_admin') OR EXISTS(SELECT 1 FROM user_sites WHERE user_id=u.id AND site_id=$2)))
      OR EXISTS(SELECT 1 FROM imprest_allocations a WHERE a.site_id=$2 AND u.id IN(a.admin_id,a.sub_admin_id))
      OR EXISTS(SELECT 1 FROM imprest_transfers t WHERE t.site_id=$2 AND u.id IN(t.from_user_id,t.to_user_id))
      OR EXISTS(SELECT 1 FROM wallet_imprest_transfers w WHERE w.site_id=$2 AND w.organization_id=$1 AND u.id IN(w.from_user_id,w.to_user_id)))
    ORDER BY u.name,u.id`,[organizationId,siteId,visible])).rows;
  if(personId!=null&&!people.some(p=>Number(p.id)===personId))throw walletError('This person has no Imprest account in the selected site.',403);
  const {page,limit,offset}=pagination(query);
  const {rows:[result]}=await db.query(confirmedImprestHandoversSql,[organizationId,siteId,visible,personId,from,to,limit,offset,direction]);
  const byPerson=new Map(result.people_totals.map(row=>[Number(row.user_id),row]));
  const peopleWithTotals=people.map(person=>{const totals=byPerson.get(Number(person.id));return {...person,
    total_given:totals?.total_given||'0',total_received:totals?.total_received||'0',
    given_count:totals?.given_count||0,received_count:totals?.received_count||0};});
  return {site_id:siteId,person_id:personId,scope:management?'management':'personal',from,to,people:peopleWithTotals,
    totals:{given:result.total_given,received:result.total_received,given_count:result.given_count,received_count:result.received_count},
    entries:result.entries,pagination:{page,limit,total:result.total,pages:Math.max(1,Math.ceil(result.total/limit))}};
}
