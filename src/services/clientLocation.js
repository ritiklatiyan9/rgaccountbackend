// Shared by reporting and geocoding. Never guess a household location from a name.
const EMPTY = /^(?:n\/?a|nil|null|none|unknown|not available|-)$/i;
export const cleanLocationText = (value) => {
  const text = String(value ?? '').normalize('NFKC').trim().replace(/\s+/g, ' ');
  return EMPTY.test(text) ? '' : text;
};
export const normaliseLocation = (value) => cleanLocationText(value).toUpperCase();
export const cleanPin = (value) => {
  const pin = cleanLocationText(value).replace(/^(?:PIN(?:CODE)?|POSTAL CODE)\s*[:\-]?\s*/i, '').replace(/\s/g, '');
  return /^[1-9]\d{5}$/.test(pin) ? pin : '';
};
const STATES = ['Andhra Pradesh', 'Arunachal Pradesh', 'Assam', 'Bihar', 'Chhattisgarh', 'Goa', 'Gujarat', 'Haryana', 'Himachal Pradesh', 'Jharkhand', 'Karnataka', 'Kerala', 'Madhya Pradesh', 'Maharashtra', 'Manipur', 'Meghalaya', 'Mizoram', 'Nagaland', 'Odisha', 'Punjab', 'Rajasthan', 'Sikkim', 'Tamil Nadu', 'Telangana', 'Tripura', 'Uttar Pradesh', 'Uttarakhand', 'West Bengal', 'Andaman and Nicobar Islands', 'Chandigarh', 'Dadra and Nagar Haveli and Daman and Diu', 'Delhi', 'Jammu and Kashmir', 'Ladakh', 'Lakshadweep', 'Puducherry'].map(normaliseLocation);
const STATE_PATTERNS = STATES.map((state) => ({ state, pattern: new RegExp(`\\b${state}\\b`) }));
const STATE_ALIASES = { UP: 'UTTAR PRADESH', UK: 'UTTARAKHAND', UA: 'UTTARAKHAND', RJ: 'RAJASTHAN', HR: 'HARYANA', DL: 'DELHI', 'NEW DELHI': 'DELHI', 'NCT OF DELHI': 'DELHI', MP: 'MADHYA PRADESH', MH: 'MAHARASHTRA', PB: 'PUNJAB', BR: 'BIHAR', GJ: 'GUJARAT', ORISSA: 'ODISHA', UTTARANCHAL: 'UTTARAKHAND' };
export const normaliseState = (value) => {
  const state = normaliseLocation(value);
  return STATE_ALIASES[state.replace(/\./g, '')] || state;
};

export const coordinates = (lat, lng) => {
  if ([lat, lng].some((v) => v == null || typeof v === 'boolean' || cleanLocationText(v) === '')) return null;
  const pair = [Number(lat), Number(lng)];
  if (!pair.every(Number.isFinite) || Math.abs(pair[0]) > 90 || Math.abs(pair[1]) > 180) return null;
  return { lat: pair[0], lng: pair[1] };
};

export function addressParts(member) {
  const address = normaliseLocation(member.address);
  // A standalone six-digit PIN can be recovered from a pasted postal address;
  // never take six digits from a phone number or silently override an invalid field.
  const pins = [...address.matchAll(/(?<![\d])([1-9]\d{5})(?![\d])/g)].map((m) => m[1]);
  const uniquePins = [...new Set(pins)];
  const pincode = cleanPin(member.pincode) || (!cleanLocationText(member.pincode) && uniquePins.length === 1 ? uniquePins[0] : '');
  const explicitState = normaliseState(member.state);
  const states = !explicitState && address ? STATE_PATTERNS.filter(({ pattern }) => pattern.test(address)) : [];
  const state = explicitState || (states.length === 1 ? states[0].state : '');
  const parts = {
    city: normaliseLocation(member.city), village: normaliseLocation(member.village),
    district: normaliseLocation(member.district), state, pincode,
  };
  return {
    ...parts,
    has_address: Boolean(address || Object.values(parts).some(Boolean)),
    can_geocode: Boolean(pincode || parts.city || parts.village || parts.district),
    invalid_pincode: Boolean(cleanLocationText(member.pincode) && !cleanPin(member.pincode)),
    inferred_pincode: Boolean(pincode && !cleanPin(member.pincode)),
  };
}

export const cacheKey = (member) => {
  const { city, village, district, state, pincode } = addressParts(member);
  return `v2|${JSON.stringify([village, city, district, state, pincode])}`;
};

// Approximate coordinates cease to describe a member when their address changes.
// A deliberate new pin or an existing manual pin always wins.
export function invalidateChangedAddress(data, existing) {
  const changed = ['address', 'city', 'village', 'district', 'state', 'pincode'].some(
    (key) => Object.hasOwn(data, key) && normaliseLocation(data[key]) !== normaliseLocation(existing[key]),
  );
  if (changed && existing.geocode_source !== 'manual' && !Object.hasOwn(data, 'latitude') && !Object.hasOwn(data, 'longitude')) {
    Object.assign(data, { latitude: null, longitude: null, geocode_source: null, geocode_precision: null, geocoded_at: null });
  }
  return data;
}
