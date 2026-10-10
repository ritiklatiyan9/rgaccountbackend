import applicationSettings from '../models/ApplicationSetting.model.js';
import { TDS_SECTIONS } from '../utils/tds.js';

export const TDS_WORKFLOW_KEY = 'tds_workflow';
export const TDS_MODULES = Object.freeze({
  "plot_commission": "Project commission",
  "land_purchase_commission": "Land purchase commission",
  "land_sale_commission": "Land sale commission",
  "farmer_payment": "Land purchase / farmer payments",
  "expense": "Expenses",
  "daybook": "Day Book",
  "cashflow": "Personal ledger",
  "firm_transaction": "Bank statement reconciliation / firm transactions",
  "vendor_payment": "Construction / vendor payments",
  "vendor_inventory_payment": "Purchasing / inventory payments",
  "misc_income": "Misc income / outgoing payments",
  "partner_profit_payment": "Site Director / partner profit payments",
  "imprest_expense": "Imprest expenses"
});
const fail = message => { throw Object.assign(new Error(message), { statusCode: 400 }); };
const money = value => Math.round((Number(value) + Number.EPSILON) * 100) / 100;
export const commissionTdsModule = master => master.plot_id ? 'plot_commission'
  : master.farmer_id ? 'land_purchase_commission' : 'land_sale_commission';
export const defaultTdsWorkflow = () => Object.fromEntries(Object.keys(TDS_MODULES)
  .map(key => [key, { enabled: false, section: key.includes('commission') ? '194H' : 'OTHER', rate: 2 }]));
export function parseTdsWorkflow(body) {
  const modules = body?.modules;
  if (!modules || typeof modules !== 'object' || Array.isArray(modules)) fail('modules is required.');
  if (Object.keys(modules).some(key => !Object.hasOwn(TDS_MODULES, key))) fail('Unsupported TDS module.');
  const result = defaultTdsWorkflow();
  for (const key of Object.keys(result)) {
    const value = modules[key];
    if (!value || typeof value.enabled !== 'boolean') fail(`Choose enabled or disabled for ${TDS_MODULES[key]}.`);
    if (!TDS_SECTIONS.includes(value.section)) fail('Choose a valid TDS section.');
    if (value.rate === '' || value.rate == null || !Number.isFinite(Number(value.rate)) || money(value.rate) <= 0 || Number(value.rate) > 100) fail('Default TDS rate must be greater than 0 and at most 100.');
    result[key] = { enabled: value.enabled, section: value.section, rate: money(value.rate) };
  }
  return result;
}
export async function getTdsWorkflow(siteId) {
  const stored = await applicationSettings.getJson(siteId, TDS_WORKFLOW_KEY, null);
  const defaults = defaultTdsWorkflow();
  for (const key of Object.keys(defaults)) if (stored?.[key]) {
    const value = stored[key];
    defaults[key] = { enabled: value.enabled === true,
      section: TDS_SECTIONS.includes(value.section) ? value.section : defaults[key].section,
      rate: Number.isFinite(Number(value.rate)) && money(value.rate) > 0 && Number(value.rate) <= 100 ? money(value.rate) : defaults[key].rate };
  }
  return defaults;
}

// `amount` is the gross settlement at this API boundary. The stored amount is
// the actual cash/bank payout, consumed by existing ledger and imprest triggers.
export function parsePaymentTds(body, config, existing = null) {
  const unchanged = existing && body.tds_applicable === undefined && body.amount === undefined
    && body.tds_mode === undefined && body.tds_rate === undefined && body.tds_amount === undefined && body.tds_section === undefined;
  if (unchanged) return { amount: Number(existing.amount), tds_amount: Number(existing.tds_amount || 0),
    tds_mode: existing.tds_mode || null, tds_rate: Number(existing.tds_rate || 0), tds_section: existing.tds_section || null };
  if (body.tds_applicable !== undefined && typeof body.tds_applicable !== 'boolean') fail('TDS Applicable must be a boolean.');
  if (existing?.tds_amount > 0 && body.amount !== undefined && body.tds_applicable === undefined) fail('Edit a TDS payment from its source module with the gross amount and TDS details.');
  const gross = money(body.amount ?? (Number(existing?.amount || 0) + Number(existing?.tds_amount || 0)));
  if (!Number.isFinite(gross) || gross === 0 || Math.abs(gross) >= 1e12) fail('Enter a valid non-zero payment amount.');
  const applicable = body.tds_applicable ?? Number(existing?.tds_amount || 0) > 0;
  if (!applicable) return { amount: gross, tds_amount: 0, tds_mode: null, tds_rate: 0, tds_section: null };
  if (gross <= 0) fail('TDS can only be deducted from an outgoing payment.');
  if (!config?.enabled && !(existing?.tds_amount > 0)) fail('Enable TDS for this module in Settings first.');
  const mode = body.tds_mode ?? existing?.tds_mode ?? 'percentage';
  if (!['percentage', 'manual'].includes(mode)) fail('Choose percentage or manual TDS.');
  const section = body.tds_section ?? existing?.tds_section ?? config.section;
  if (!TDS_SECTIONS.includes(section)) fail('Choose a valid TDS section.');
  const rateInput = body.tds_rate ?? existing?.tds_rate ?? config.rate;
  const rate = money(rateInput);
  if (mode === 'percentage' && (rateInput === '' || !Number.isFinite(rate) || rate <= 0 || rate > 100)) fail('TDS rate must be greater than 0 and at most 100.');
  const deduction = mode === 'percentage' ? money(gross * rate / 100) : money(body.tds_amount ?? existing?.tds_amount);
  if (!Number.isFinite(deduction) || deduction <= 0 || deduction >= gross) fail('TDS must be greater than zero and less than the gross amount.');
  return { amount: money(gross - deduction), tds_amount: deduction, tds_mode: mode,
    tds_rate: mode === 'manual' ? money(deduction / gross * 100) : rate, tds_section: section === '194H' && String(body.date || body.payment_date || '').slice(0,10) >= '2026-04-01' ? '393_1_1ii' : section };
}
