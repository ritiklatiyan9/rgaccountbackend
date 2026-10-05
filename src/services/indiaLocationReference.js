import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

// Public reference data only. No client address leaves the application.
const reference = JSON.parse(gunzipSync(readFileSync(new URL('../data/india-locations.json.gz', import.meta.url))));
export const placeKey = value => String(value ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
  .toUpperCase().replace(/[^\p{L}\p{N}\p{M}]+/gu, ' ').trim().replace(/\s+/g, ' ')
  .replace(/\b(?:[A-Z] ){3,}[A-Z]\b/g, letters => letters.replaceAll(' ', ''));
// Some uploaded forms still contain their designer's filler address. “Amet”
// is also a real town, so recognizing its word inside Lorem ipsum is unsafe.
export const isPlaceholderAddress = value => /\blorem\s+ips[ua]m\b|लोरम\s+इप्सम|डॉलर\s+सिट\s+अमेट.*एलिट|\b[A-Z0-9]*X{4,}[A-Z0-9]*\b/i.test(String(value ?? '').normalize('NFKC'));
const stateKey = value => placeKey(value).replace(/^(STATE OF |UNION TERRITORY OF |NATIONAL CAPITAL TERRITORY OF )/, '');
const districtKey = value => placeKey(value).replace(/\s+DISTRICT$/, '');
const pins = new Map(reference.pins.map(([pincode, state, district, lat, lng]) => [pincode, { pincode, state, district, lat, lng, precision: 'pincode', source: 'geonames' }]));
const aliases = new Map();
for (const [city, names, state, district, lat, lng] of reference.cities) {
  const point = { city, state, district, lat, lng, precision: 'city', source: 'geonames' };
  for (const name of new Set(names.map(placeKey))) {
    if (name.length < 4) continue;
    if (!aliases.has(name)) aliases.set(name, []);
    aliases.get(name).push(point);
  }
}

const uniquePlace = (candidates, { state, district } = {}) => {
  const filtered = candidates.filter(point => (!state || stateKey(point.state) === stateKey(state))
    && (!district || districtKey(point.district) === districtKey(district)));
  if (!filtered.length) return null;
  const first = filtered[0];
  // Namesakes may share a spelling; never pick the first distant location.
  return filtered.every(point => Math.abs(point.lat - first.lat) + Math.abs(point.lng - first.lng) < 0.15) ? first : null;
};

// Verified postal corrections survive regeneration of the upstream reference.
// Coordinates still come from a named public locality, never from an AI guess.
const postalCorrections = JSON.parse(readFileSync(new URL('../data/india-postal-corrections.json', import.meta.url)));
for (const correction of postalCorrections) {
  const locality = uniquePlace(aliases.get(placeKey(correction.city)) || [], correction);
  if (!locality) throw new Error(`Missing locality for postal correction ${correction.pincode}`);
  for (const alias of correction.aliases || []) {
    const key = placeKey(alias);
    if (!aliases.has(key)) aliases.set(key, []);
    if (!aliases.get(key).includes(locality)) aliases.get(key).push(locality);
  }
  pins.set(correction.pincode, { ...locality, pincode: correction.pincode, precision: 'pincode', postal_correction: correction });
}

const fromAddress = (address, constraints) => {
  if (isPlaceholderAddress(address)) return null;
  const words = placeKey(String(address ?? '').replace(/(?:C\s*\/\s*O|S\s*\/\s*O|D\s*\/\s*O|W\s*\/\s*O|CARE OF)\b[^,;]*(?:[,;]|$)/gi, ' ')).split(' ');
  const matches = [];
  for (let end = 0; end < words.length; end++) {
    if (/^(ROAD|RD|STREET|MARG|LANE|HIGHWAY)$/.test(words[end + 1] || '')) continue;
    for (let length = Math.min(6, end + 1); length >= 1; length--) {
      const name = words.slice(end - length + 1, end + 1).join(' ');
      const candidates = aliases.get(name);
      if (!candidates) continue;
      const point = uniquePlace(candidates, constraints);
      if (point) { matches.push({ ...point, position: end }); break; }
    }
  }
  const last = matches.at(-1);
  if (!last) return null;
  // Distinct towns in an address without any region/PIN are ambiguous.
  if (!constraints.state && !constraints.district && matches.some(p => Math.abs(p.lat - last.lat) + Math.abs(p.lng - last.lng) > 0.5)) return null;
  const { position: _position, ...point } = last;
  return point;
};

export function lookupIndianLocation({ pincode, state, district, village, city, address } = {}) {
  if (pincode) {
    const point = pins.get(String(pincode));
    if (!point || (state && stateKey(state) !== stateKey(point.state))) return null;
    // Postal data can use historical district names or district centroids.
    // Prefer a recognized nearby town while preserving the supplied PIN/state.
    const constraints = { state: point.state, ...(point.postal_correction ? { district: point.district } : {}) };
    const locality = [village, city].filter(Boolean).map(name => uniquePlace(aliases.get(placeKey(name)) || [], constraints)).find(Boolean)
      || fromAddress(address, constraints);
    const nearby = locality && Math.hypot((locality.lat - point.lat) * 111, (locality.lng - point.lng) * 111 * Math.cos(point.lat * Math.PI / 180)) <= 75;
    const districtMatches = !district || !point.district || districtKey(district) === districtKey(point.district)
      || point.postal_correction?.previous_districts.some(name => districtKey(name) === districtKey(district))
      || (nearby && districtKey(district) === districtKey(locality.district));
    if (!districtMatches) return null;
    return nearby ? { ...locality, pincode: point.pincode, ...(point.postal_correction ? { postal_correction: point.postal_correction } : {}) } : { ...point };
  }
  for (const [name, precision] of [[village, 'village'], [city, 'city'], [district, 'district']]) {
    if (!name) continue;
    const point = uniquePlace(aliases.get(placeKey(name)) || [], { state, district: precision === 'district' ? '' : district });
    if (point) return { ...point, precision, ...(precision === 'district' ? { city: '' } : {}) };
  }
  return fromAddress(address, { state, district });
}

export const sameIndianPlace = (left, right) => {
  const a = aliases.get(placeKey(left)) || [], b = aliases.get(placeKey(right)) || [];
  return a.some(point => b.includes(point));
};
