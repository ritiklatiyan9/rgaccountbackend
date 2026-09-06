/** Additive project metadata. Missing profiles and unit types always mean legacy plots. */
export const DEFAULT_PROJECT_PROFILE = Object.freeze({ inventory_type: 'plots', authority_type: 'unconfigured', rera_status: 'unconfigured' });
const fail = (message, statusCode = 400) => { throw Object.assign(new Error(message), { statusCode }); };
const object = (value, label) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  return value;
};
const choice = (value, options, label) => options.includes(value) ? value : fail(`Invalid ${label}`);
const text = (value, label, max = 200) => {
  if (value == null || value === '') return '';
  if (typeof value !== 'string' || value.length > max) fail(`${label} must be text of at most ${max} characters`);
  return value.trim();
};
const date = (value, label) => {
  const result = text(value, label, 10);
  if (result && (!/^\d{4}-\d{2}-\d{2}$/.test(result) || Number.isNaN(Date.parse(result)) || new Date(result).toISOString().slice(0, 10) !== result)) fail(`Invalid ${label}`);
  return result;
};
export const allowedUnitTypes = (profile) => profile?.inventory_type === 'flats' ? ['flat'] : profile?.inventory_type === 'mixed' ? ['plot', 'flat'] : ['plot'];

export function validateProjectProfile(input) {
  object(input, 'Project profile');
  const p = { ...DEFAULT_PROJECT_PROFILE, ...input };
  const result = {
    inventory_type: choice(p.inventory_type, ['plots', 'flats', 'mixed'], 'inventory type'),
    authority_type: choice(p.authority_type, ['unconfigured', 'local', 'mda', 'other'], 'approval authority'),
    rera_status: choice(p.rera_status, ['unconfigured', 'registered', 'applied', 'not_applicable'], 'RERA status'),
  };
  for (const key of ['promoter_name', 'phase', 'authority_name', 'approval_number', 'rera_number', 'rera_authority', 'rera_application_number', 'rera_exemption_reason']) result[key] = text(p[key], key);
  for (const key of ['approval_date', 'approval_valid_until', 'rera_valid_until', 'expected_completion']) result[key] = date(p[key], key);
  if (result.authority_type !== 'unconfigured') {
    if (!result.authority_name || !result.approval_number || !result.approval_date) fail('Authority name, approval number and approval date are required');
  }
  if (result.rera_status === 'registered' && (!result.rera_number || !result.rera_authority || !result.rera_valid_until || !result.promoter_name)) fail('Registered RERA projects require promoter, RERA authority, registration number and validity date');
  if (result.rera_status === 'applied' && !result.rera_application_number) fail('RERA application reference is required');
  if (result.rera_status === 'not_applicable' && !result.rera_exemption_reason) fail('Record the reason RERA is not applicable');
  if (result.approval_date && result.approval_valid_until && result.approval_valid_until < result.approval_date) fail('Approval validity cannot precede the approval date');
  return result;
}

export function validateUnitMetadata(input, profile, existing = null) {
  const type = choice(input.unit_type ?? existing?.unit_type ?? 'plot', ['plot', 'flat'], 'unit type');
  if (existing && type !== (existing.unit_type || 'plot')) fail('An existing unit cannot change type. Create a separate unit to preserve its area and payment history.', 409);
  if (!existing && !allowedUnitTypes(profile).includes(type)) fail('This unit type is not enabled in the site profile');
  if (input.unit_details === undefined && existing) return {};
  const raw = object(input.unit_details ?? {}, 'Unit details');
  const details = { ...(existing?.unit_details || {}) };
  for (const key of ['tower', 'floor', 'bedrooms', 'parking', 'facing', 'khasra_no', 'approval_reference', 'allotment_no']) {
    if (key in raw) details[key] = text(raw[key], key, 100);
  }
  for (const key of ['agreement_date', 'possession_date']) if (key in raw) details[key] = date(raw[key], key);
  for (const key of ['carpet_area', 'built_up_area', 'super_built_up_area', 'balcony_area']) {
    if (!(key in raw)) continue;
    const value = raw[key];
    if (value === '' || value == null) { details[key] = null; continue; }
    if (!['number', 'string'].includes(typeof value) || !Number.isFinite(Number(value)) || Number(value) <= 0 || Number(value) > 1e9) fail(`${key.replaceAll('_', ' ')} must be a positive number`);
    details[key] = Number(value);
  }
  if ('area_basis' in raw) details.area_basis = choice(raw.area_basis, ['carpet', 'built_up', 'super_built_up'], 'sale area basis');
  if (type === 'flat') {
    if (!details.tower || !details.floor || !details.bedrooms || !details.carpet_area || !details.area_basis) fail('Flats require tower, floor, configuration, carpet area and sale area basis');
    if (!details[`${details.area_basis}_area`]) fail('Enter the area for the selected sale area basis');
    for (const key of ['built_up_area', 'super_built_up_area']) if (details[key] && details[key] < details.carpet_area) fail('Built-up areas cannot be smaller than carpet area');
  }
  if (details.agreement_date && details.possession_date && details.possession_date < details.agreement_date) fail('Possession date cannot precede the agreement date');
  return { unit_type: type, unit_details: details };
}

function validateFlatSaleArea(input, metadata, existing) {
  const type = metadata.unit_type || existing?.unit_type;
  if (type !== 'flat') return;
  const details = metadata.unit_details || existing?.unit_details || {};
  const area = Number(input.plot_size ?? existing?.plot_size);
  if (!Number.isFinite(area) || area <= 0 || Math.abs(area - Number(details[`${details.area_basis}_area`])) > 0.01) fail('Flat sale area must match the selected area basis');
}

export async function unitMetadataForWrite(input, siteId, db, existing = null) {
  if (existing && input.unit_details === undefined) {
    const metadata = validateUnitMetadata(input, null, existing);
    if (input.plot_size !== undefined) validateFlatSaleArea(input, metadata, existing);
    return metadata;
  }
  const { rows: [site] } = await db.query('SELECT project_profile FROM sites WHERE id = $1', [siteId]);
  if (!site) fail('Site not found', 404);
  const metadata = validateUnitMetadata(input, site.project_profile, existing);
  validateFlatSaleArea(input, metadata, existing);
  return metadata;
}
