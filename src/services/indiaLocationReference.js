import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

// Public reference data only. No client address leaves the application.
const reference = JSON.parse(gunzipSync(readFileSync(new URL('../data/india-locations.json.gz', import.meta.url))));
export const placeKey = value => String(value ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
  .toUpperCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');
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

const fromAddress = (address, constraints) => {
  const words = placeKey(address).split(' ');
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
    if (!point || (state && stateKey(state) !== stateKey(point.state))
      || (district && point.district && districtKey(district) !== districtKey(point.district))) return null;
    const locality = fromAddress(address, { state: point.state, district: point.district });
    return { ...point, ...(locality ? { city: locality.city } : {}) };
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
