import { assertMemberSiteAccess, normalizeMemberName, normalizeMemberPhone } from './memberPhoneReuse.service.js';
import { findSiteRegistrationMatches } from './memberSiteRegistration.service.js';
import { uniqueMemberNameMatch, memberTransactionMatch } from './memberLedgerIdentity.service.js';
import { findMemberPlots, PLOT_BUYER_MEMBER_JOIN } from './plotMemberLinks.service.js';

const admin = user => ['admin', 'super_admin'].includes(user.role);
const fail = (message, statusCode) => { throw Object.assign(new Error(message), { statusCode }); };
const party = (alias, key) => `EXISTS (SELECT 1 FROM transaction_party_links link
  WHERE link.site_id = $1 AND link.member_id = $2 AND link.source_key = '${key}' AND link.source_id = ${alias}.id)`;
const scoped = alias => `($3::int IS NULL OR (to_jsonb(${alias})->>'created_by')::int = $3)`;
const explicitOrName = (alias, field, name) => `(${alias}.${field} = $2 OR (${alias}.${field} IS NULL AND ${uniqueMemberNameMatch(`${alias}.${name}`)}))`;
const jsonMember = (alias, field) => `(to_jsonb(${alias})->>'${field}')::int = $2`;
const arrayMember = (alias, field) => `EXISTS (SELECT 1 FROM jsonb_array_elements_text(COALESCE(NULLIF(to_jsonb(${alias})->'${field}', 'null'::jsonb), '[]'::jsonb)) value WHERE value::int = $2)`;
const aadhaar = value => { const digits = String(value || '').replace(/\D/g, ''); return /^\d{12}$/.test(digits) && !/^(\d)\1{11}$/.test(digits) ? digits : ''; };
const pan = value => { const code = String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); return /^[A-Z]{5}\d{4}[A-Z]$/.test(code) ? code : ''; };
const matchesIdentity = (source, target) => Boolean(normalizeMemberName(source.full_name)
  && normalizeMemberName(target.full_name) === normalizeMemberName(source.full_name)
  && ((normalizeMemberPhone(source.phone) && normalizeMemberPhone(source.phone) === normalizeMemberPhone(target.phone))
    || (aadhaar(source.aadhar_no) && aadhaar(source.aadhar_no) === aadhaar(target.aadhar_no))
    || (pan(source.pan_no) && pan(source.pan_no) === pan(target.pan_no))));
const daybookKey = `COALESCE(${[
  ['expense_id', 'expenses'], ['farmer_payment_id', 'farmer_payments'], ['commission_id', 'plot_commissions'],
  ['cash_flow_entry_id', 'personal_ledger'], ['firm_transaction_id', 'firm_transactions'], ['plot_payment_id', 'plot_payments'],
  ['vendor_payment_id', 'vendor_payments'],
].map(([field, key]) => `'${key}:' || (to_jsonb(d)->>'${field}')`).join(',')},
  (to_jsonb(d)->>'source_key') || ':' || (to_jsonb(d)->>'source_id'), 'day_book:' || d.id)`;

// Counts refer to records in each module's list, including unpaid commitments.
// The same IDs drive the destination filter, so a name collision cannot broaden it.
export const MEMBER_LINK_MODULES = [
  { key: 'plot_payments', label: 'Project payments', permission: 'plot_payments', path: '/plot-payments', unit: 'plots', plots: true },
  { key: 'plot_registry', label: 'Registry', permission: 'plot_registry', path: '/plot-registry', unit: 'registries', sql: `SELECT r.id FROM plot_registries r
    LEFT JOIN plots p ON p.id=r.plot_id AND p.site_id=r.site_id ${PLOT_BUYER_MEMBER_JOIN} WHERE r.site_id=$1 AND (
    ${['noc_farmer_member_id', 'noc_authorized_member_id'].map(field => jsonMember('r', field)).join(' OR ')}
    OR ${['noc_client_member_ids', 'noc_farmer_member_ids', 'noc_authorized_member_ids'].map(field => arrayMember('r', field)).join(' OR ')}
    OR plot_buyer.id=$2 OR (buyer_link.member_id IS NULL AND ${uniqueMemberNameMatch('r.customer_name')})
    OR ((to_jsonb(r)->>'noc_farmer_member_id') IS NULL
      AND COALESCE(jsonb_array_length(NULLIF(to_jsonb(r)->'noc_farmer_member_ids','null'::jsonb)),0)=0
      AND ${uniqueMemberNameMatch('r.farmer_name')}))` },
  { key: 'commissions', label: 'Project commission', permission: 'commissions', path: '/plot-commission', unit: 'plots', sql: `SELECT DISTINCT p.id FROM plots p WHERE p.site_id=$1 AND (
    EXISTS (SELECT 1 FROM plot_commissions_v2 c WHERE c.site_id=$1 AND c.plot_id=p.id AND c.agent_id=$2)
    OR EXISTS (SELECT 1 FROM plot_commissions c WHERE c.site_id=$1 AND UPPER(c.plot_no)=UPPER(p.plot_no) AND ${uniqueMemberNameMatch('c.particular')})
    OR ${uniqueMemberNameMatch('p.booking_by')})` },
  { key: 'expenses', label: 'Expenses', permission: 'expenses', path: '/expenses', unit: 'entries', sql: `SELECT e.id FROM expenses e WHERE e.site_id=$1 AND ${scoped('e')} AND (${party('e', 'expense')} OR ${memberTransactionMatch('e', ['e.to_entity', 'e.from_entity'], { assigned: true })})` },
  { key: 'daybook', label: 'Day book', permission: 'daybook', path: '/daybook', unit: 'entries', sql: `SELECT d.id, ${daybookKey} AS record_key FROM day_book d WHERE d.site_id=$1 AND ${scoped('d')} AND (${party('d', 'daybook')} OR ${memberTransactionMatch('d', ['d.to_entity', 'd.from_entity'], { assigned: true })})` },
  { key: 'farmers', label: 'Land purchase', permission: 'farmers', path: '/farmers', unit: 'lands', sql: `SELECT f.id FROM farmers f WHERE f.site_id=$1 AND ${explicitOrName('f', 'member_id', 'name')}` },
  { key: 'cashflow', label: 'Personal ledger', permission: 'cashflow', path: '/cashflow', unit: 'ledgers', sql: `SELECT l.id FROM cash_flow_months l WHERE l.site_id=$1 AND (l.linked_member_id=$2 OR EXISTS (
    SELECT 1 FROM cash_flow_entries e WHERE e.cash_flow_month_id=l.id AND ${party('e', 'cashflow_entry')}))` },
  { key: 'firm_transactions', label: 'Firm transactions', permission: 'firm_transactions', path: '/firm-transactions', unit: 'entries', sql: `SELECT t.id, t.firm_id FROM firm_transactions t JOIN firms f ON f.id=t.firm_id WHERE f.site_id=$1 AND (${party('t', 'firm_transaction')} OR ${memberTransactionMatch('t', ['t.name'])})` },
  { key: 'vendors', label: 'Vendor commitments', permission: 'vendors', path: '/construction-vendors/vendors', unit: 'commitments', sql: `SELECT v.id FROM vendor_commitments v WHERE v.site_id=$1 AND ${explicitOrName('v', 'vendor_member_id', 'vendor_name')}` },
  { key: 'purchasing', label: 'Purchasing', permission: 'vendors', path: '/construction-vendors/purchasing', unit: 'orders', sql: `SELECT v.id FROM vendor_inventory_orders v WHERE v.site_id=$1 AND ${scoped('v')} AND ${explicitOrName('v', 'vendor_member_id', 'vendor_name')}` },
  { key: 'misc_income', label: 'Miscellaneous income', permission: 'misc_income', path: '/misc-income', unit: 'entries', sql: `SELECT e.id FROM misc_income_entries e WHERE e.site_id=$1 AND ${scoped('e')} AND (${party('e', 'misc_income_entry')} OR ${uniqueMemberNameMatch('e.party_name')})` },
];

export async function getMemberLinks(db, { memberId, siteId, user, permissions = new Map(), allSites = false }) {
  const { rows: [member] } = await db.query('SELECT * FROM members WHERE id=$1', [memberId]);
  if (!member) fail('Member not found', 404);
  if (!await assertMemberSiteAccess(db, user, member.site_id)) fail('This client is unavailable to your account', 403);
  const selectedSiteId = siteId || member.site_id;
  if (Number(selectedSiteId) !== Number(member.site_id)) fail('Open this client in their registered site to view linked modules.', 400);
  const { rows: sites } = await db.query(`SELECT s.id, s.name FROM sites s WHERE s.organization_id=$1
    ${admin(user) ? '' : 'AND EXISTS (SELECT 1 FROM user_sites us WHERE us.site_id=s.id AND us.user_id=$2)'} ORDER BY s.name, s.id`,
  admin(user) ? [user.organization_id] : [user.organization_id, user.id]);
  const matches = await findSiteRegistrationMatches(db, { memberIds: [member.id], siteIds: sites.map(site => site.id), includeProfile: true });
  const registrations = matches.filter(target => target.id === member.id
    || (member.shared_profile_id && target.shared_profile_id === member.shared_profile_id)
    || matchesIdentity(member, target));
  const linkedSites = sites.flatMap(site => {
    const candidates = registrations.filter(target => Number(target.site_id) === Number(site.id));
    if (!candidates.length) return [];
    const target = candidates.find(candidate => candidate.id === member.id) || candidates[0];
    return [{ id: site.id, name: site.name, member_id: target.id, kyc_status: target.kyc_status || null, registration_count: candidates.length }];
  });
  const loadModules = async (registration) => Promise.all(MEMBER_LINK_MODULES.map(async definition => {
    const permission = permissions.get(definition.permission);
    if (!admin(user) && permission?.can_read !== true) return null;
    const creator = !admin(user) && permission?.can_view_all !== true ? user.id : null;
    let rows;
    if (definition.plots) {
      rows = (await findMemberPlots(registration.site_id, db)).get(String(registration.id)) || [];
      if (creator !== null) {
        const { rows: visible } = await db.query('SELECT id FROM plots WHERE site_id=$1 AND id=ANY($2::int[]) AND created_by=$3', [registration.site_id, rows.map(row => row.id), creator]);
        rows = visible;
      }
    } else {
      const usesCreator = definition.sql.includes('$3');
      ({ rows } = await db.query(definition.sql, usesCreator ? [registration.site_id, registration.id, creator] : [registration.site_id, registration.id]));
    }
    const ids = [...new Set(rows.map(row => Number(row.id)))];
    const recordKeys = [...new Set(rows.map(row => row.record_key).filter(Boolean))];
    return { key: definition.key, label: definition.label, permission: definition.permission, path: definition.path,
      unit: definition.unit, count: recordKeys.length || ids.length, record_ids: ids,
      ...(recordKeys.length ? { record_keys: recordKeys } : {}),
      ...(definition.key === 'firm_transactions' ? { parent_ids: [...new Set(rows.map(row => Number(row.firm_id)))] } : {}) };
  }));
  let modules;
  const scopedRegistrations = allSites ? registrations : registrations.filter(registration => Number(registration.site_id) === Number(selectedSiteId));
  if (allSites || scopedRegistrations.length > 1) {
    const perRegistration = await Promise.all(scopedRegistrations.map(async registration => ({ registration, modules: await loadModules(registration) })));
    const grouped = new Map();
    for (const { registration, modules: localModules } of perRegistration) {
      for (const module of localModules.filter(item => item?.count > 0)) {
        if (!grouped.has(module.key)) grouped.set(module.key, { ...module, count: 0, site_links: [] });
        const aggregate = grouped.get(module.key);
        aggregate.record_ids = [...new Set([...aggregate.record_ids, ...module.record_ids])];
        aggregate.parent_ids = [...new Set([...(aggregate.parent_ids || []), ...(module.parent_ids || [])])];
        aggregate.record_keys = [...new Set([...(aggregate.record_keys || []), ...(module.record_keys || [])])];
        const site = sites.find(item => Number(item.id) === Number(registration.site_id));
        let link = aggregate.site_links.find(item => Number(item.site_id) === Number(site.id));
        if (!link) {
          link = { site_id: site.id, site_name: site.name, member_id: registration.id, count: 0, record_ids: [], record_keys: [] };
          aggregate.site_links.push(link);
        }
        link.record_ids = [...new Set([...link.record_ids, ...module.record_ids])];
        link.record_keys = [...new Set([...link.record_keys, ...(module.record_keys || [])])];
        link.count = link.record_keys.length || link.record_ids.length;
      }
    }
    modules = MEMBER_LINK_MODULES.map(definition => grouped.get(definition.key)).filter(Boolean);
    for (const module of modules) module.count = module.site_links.reduce((sum, site) => sum + site.count, 0);
  } else modules = await loadModules(member);
  return { member: { id: member.id, full_name: member.full_name, site_id: member.site_id },
    modules: modules.filter(module => module?.count > 0), sites: linkedSites };
}
