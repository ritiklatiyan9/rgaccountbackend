import pool from '../config/db.js';

// Nominatim usage policy: identify the app, max 1 req/s, cache results.
const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
const PINCODE_URL = 'https://api.postalpincode.in/pincode/';
const THROTTLE_MS = 1100;
const FETCH_TIMEOUT_MS = 12_000;
const userAgent = () => `RGAccounts/1.0 (+${process.env.FRONTEND_URL || process.env.OPENROUTER_APP_URL || 'https://rgaccountbackend.onrender.com'})`;

// ponytail: process-local throttle; a second instance would double the rate — move to a queue/worker if scaled out.
let lastCallAt = 0;
const throttle = async () => {
  const wait = lastCallAt + THROTTLE_MS - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  lastCallAt = Date.now();
};

const fetchJson = async (url, headers = {}) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { headers, signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
};

const norm = (value) => String(value || '').trim().toLowerCase();
const cleanPin = (value) => (/^\d{6}$/.test(String(value || '').trim()) ? String(value).trim() : '');
export const cacheKey = ({ city, state, pincode }) => `${norm(city)}|${norm(state)}|${cleanPin(pincode)}`;

const toCoord = (value, limit) => {
  const number = Number(value);
  return Number.isFinite(number) && Math.abs(number) <= limit ? Number(number.toFixed(6)) : null;
};

/** One live Nominatim structured query. Returns { lat, lng, precision, raw } or null. */
const nominatimSearch = async (params) => {
  await throttle();
  const query = new URLSearchParams({ format: 'jsonv2', countrycodes: 'in', limit: '1', addressdetails: '1', ...params });
  const rows = await fetchJson(`${NOMINATIM_URL}?${query}`, { 'User-Agent': userAgent(), 'Accept-Language': 'en' });
  const hit = Array.isArray(rows) ? rows[0] : null;
  if (!hit) return null;
  const lat = toCoord(hit.lat, 90);
  const lng = toCoord(hit.lon, 180);
  if (lat === null || lng === null) return null;
  return { lat, lng, precision: String(hit.addresstype || hit.type || 'unknown').slice(0, 40), raw: hit };
};

/**
 * Cached geocode for a city/state/pincode triple. Misses are cached too (lat/lng NULL)
 * so the batch does not re-hit Nominatim for the same unresolvable address.
 * Returns { lat, lng, precision, source } or null.
 */
export const geocodeAddress = async ({ city, state, pincode }) => {
  const pin = cleanPin(pincode);
  if (!norm(city) && !pin) return null;
  const key = cacheKey({ city, state, pincode: pin });

  const cached = await pool.query('SELECT lat, lng, precision, source FROM geocode_cache WHERE query_key = $1', [key]);
  if (cached.rows[0]) {
    const row = cached.rows[0];
    return row.lat === null ? null : { lat: Number(row.lat), lng: Number(row.lng), precision: row.precision, source: row.source };
  }

  const attempts = [];
  if (norm(city) && pin) attempts.push({ city, state: state || '', postalcode: pin });
  if (pin) attempts.push({ postalcode: pin });
  if (norm(city)) attempts.push({ city, state: state || '' });

  let hit = null;
  for (const attempt of attempts) {
    hit = await nominatimSearch(attempt);
    if (hit) break;
  }

  await pool.query(
    `INSERT INTO geocode_cache (query_key, lat, lng, precision, source, raw)
     VALUES ($1, $2, $3, $4, 'nominatim', $5)
     ON CONFLICT (query_key) DO UPDATE SET lat = EXCLUDED.lat, lng = EXCLUDED.lng, precision = EXCLUDED.precision, raw = EXCLUDED.raw, created_at = now()`,
    [key, hit?.lat ?? null, hit?.lng ?? null, hit?.precision ?? null, hit ? JSON.stringify(hit.raw) : null],
  );
  return hit ? { lat: hit.lat, lng: hit.lng, precision: hit.precision, source: 'nominatim' } : null;
};

/** India Post lookup: pincode -> { district, state, block } or null. */
export const pincodeInfo = async (pin) => {
  const code = cleanPin(pin);
  if (!code) return null;
  const data = await fetchJson(`${PINCODE_URL}${code}`, { 'User-Agent': userAgent() });
  const office = data?.[0]?.PostOffice?.[0];
  if (!office) return null;
  return { district: office.District || null, state: office.State || null, block: office.Block || null };
};

/**
 * Geocodes members of a site that have no coordinates yet. Manual pins are never overwritten.
 * Returns { processed, geocoded, remaining, skipped_no_address }.
 */
export const geocodePendingMembers = async ({ siteId, limit = 100 }) => {
  const cap = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const { rows } = await pool.query(
    `SELECT id, city, state, pincode
       FROM members
      WHERE site_id = $1 AND latitude IS NULL AND geocode_source IS DISTINCT FROM 'manual'
      ORDER BY id
      LIMIT $2::int`,
    [siteId, cap],
  );

  let geocoded = 0;
  let skippedNoAddress = 0;
  for (const member of rows) {
    const pin = cleanPin(member.pincode);
    if (!norm(member.city) && !pin) { skippedNoAddress += 1; continue; }
    try {
      let { state } = member;
      let district = null;
      if (pin && !norm(state)) {
        const info = await pincodeInfo(pin).catch(() => null);
        if (info) { state = info.state; district = info.district; }
      }
      const hit = await geocodeAddress({ city: member.city, state, pincode: pin });
      if (!hit) continue;
      await pool.query(
        `UPDATE members
            SET latitude = $2, longitude = $3, geocode_source = 'nominatim', geocode_precision = $4, geocoded_at = now(),
                state = COALESCE(state, UPPER($5)), district = COALESCE(district, UPPER($6))
          WHERE id = $1 AND geocode_source IS DISTINCT FROM 'manual'`,
        [member.id, hit.lat, hit.lng, hit.precision, state || null, district],
      );
      geocoded += 1;
    } catch (error) {
      console.error(`[Geocode] member ${member.id} failed:`, error.message);
    }
  }

  const remainingResult = await pool.query(
    `SELECT COUNT(*)::int AS remaining
       FROM members
      WHERE site_id = $1 AND latitude IS NULL AND geocode_source IS DISTINCT FROM 'manual'
        AND (NULLIF(TRIM(city), '') IS NOT NULL OR pincode ~ '^\\d{6}$')`,
    [siteId],
  );

  return {
    processed: rows.length,
    geocoded,
    remaining: Number(remainingResult.rows[0]?.remaining || 0),
    skipped_no_address: skippedNoAddress,
  };
};
