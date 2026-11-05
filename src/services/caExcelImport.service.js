import pool from '../config/db.js';
import permissionModel from '../models/permission.model.js';
import { assertImportSite, excelUploadAllowed } from './caWorkflow.service.js';
import { CA_EXCEL_MODULES, publicImportModule } from './caExcelModules.js';

const fail = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const isAdmin = actor => ['admin', 'super_admin'].includes(actor?.role);
export function validateImportRow(spec, row) {
  if (!row || Array.isArray(row) || typeof row !== 'object') throw fail('An import row is required.');
  const allowed = new Set(spec.fields.map(field => field.key));
  for (const key of Object.keys(row)) if (!allowed.has(key)) throw fail(`Unrecognised column: ${key}`);
  const clean = {};
  for (const field of spec.fields) {
    const raw = row[field.key];
    if (raw != null && !['string', 'number'].includes(typeof raw)) throw fail(`${field.key} must contain a text or numeric value.`);
    if (raw == null || String(raw).trim() === '') {
      if (field.required) throw fail(`${field.key} is required.`);
      continue;
    }
    let value = String(raw).trim();
    if (field.type === 'number' || field.type === 'id') {
      if (!/^-?\d+(?:\.\d+)?$/.test(value) || !Number.isFinite(Number(value))) throw fail(`${field.key} must be a number.`);
      value = Number(value);
      if (field.type === 'id' && (!Number.isSafeInteger(value) || value <= 0 || value > 2147483647)) throw fail(`${field.key} must be a positive record ID.`);
      if (field.type === 'number' && value < 0) throw fail(`${field.key} cannot be negative.`);
      if (field.key === 'amount' && value <= 0) throw fail('amount must be greater than zero.');
    } else if (field.type === 'date') {
      const parsed = /^\d{4}-\d{2}-\d{2}$/.test(value) && new Date(`${value}T00:00:00Z`);
      if (!parsed || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) throw fail(`${field.key} must be a valid YYYY-MM-DD date.`);
    } else if (value.length > 10000) throw fail(`${field.key} is too long.`);
    if (field.options) {
      value = field.options.find(option => option.toLowerCase() === String(value).toLowerCase());
      if (!value) throw fail(`${field.key} must be one of: ${field.options.join(', ')}.`);
    }
    clean[field.key] = value;
  }
  if (allowed.has('debit') && allowed.has('credit') && !((Number(clean.debit || 0) > 0) !== (Number(clean.credit || 0) > 0))) {
    throw fail('Enter a positive debit or credit, in one column only.');
  }
  return clean;
}

export async function importCatalog(actor, siteId, db = pool) {
  if (!await excelUploadAllowed(actor, db)) throw fail('Excel upload is not enabled for your account.', 403);
  await assertImportSite(actor, siteId, db);
  const grants = isAdmin(actor) ? null : await permissionModel.getPermissions(actor.id, CA_EXCEL_MODULES.map(spec => spec.permission), db);
  return CA_EXCEL_MODULES.filter(spec => !grants || grants.get(spec.permission)?.can_write === true).map(publicImportModule);
}

export async function prepareExcelImport(actor, envelope, db = pool) {
  if (!await excelUploadAllowed(actor, db)) throw fail('Excel upload is not enabled for your account. Ask an admin to enable it in Settings → CA Workflow.', 403);
  const spec = CA_EXCEL_MODULES.find(item => item.key === envelope?.module);
  if (!spec) throw fail('Choose a supported module.');
  const siteId = envelope.site_id;
  await assertImportSite(actor, siteId, db);
  if (!isAdmin(actor)) {
    const grants = await permissionModel.getPermissions(actor.id, [spec.permission], db);
    if (grants.get(spec.permission)?.can_write !== true) throw fail('Create permission is required for this module.', 403);
  }
  const body = { ...validateImportRow(spec, envelope.row), site_id: Number(siteId) };
  if (spec.key === 'registry') {
    body.payments = [{ source_plot_payment_id: body.source_plot_payment_id }];
    delete body.source_plot_payment_id;
  }
  let target = spec.target;
  if (spec.parent) {
    const [key, table] = spec.parent;
    // Table names come exclusively from the fixed catalogue above.
    const { rows } = await db.query(`SELECT id FROM ${table} WHERE id=$1 AND site_id=$2`, [body[key], body.site_id]);
    if (!rows.length) throw fail(`${key} does not belong to the selected site.`, 403);
    target = target.replace(`:${key}`, String(body[key]));
    if (spec.target.includes(`:${key}`)) delete body[key];
  }
  return { target, body };
}
