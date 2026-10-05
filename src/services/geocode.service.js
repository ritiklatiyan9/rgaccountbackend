import pool from '../config/db.js';
import { addressParts, cacheKey, cleanPin, coordinates, normaliseState } from './clientLocation.js';
import { lookupIndianLocation } from './indiaLocationReference.js';
import { loadClientMapAddresses } from './clientMapAddresses.service.js';
import { locateAddressWithAi } from './clientAddressAi.service.js';

export { cacheKey } from './clientLocation.js';
// User-triggered, small batches only. See docs/client-map-analytics.md for provider policy.
const endpoint = () => process.env.NOMINATIM_URL || 'https://nominatim.openstreetmap.org/search';
const FETCH_TIMEOUT_MS = 4500;
const BATCH_MS = 20_000;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const NO_COORDINATES = `(latitude IS NULL OR longitude IS NULL OR latitude NOT BETWEEN -90 AND 90 OR longitude NOT BETWEEN -180 AND 180)`;

export function searchAttempts(member) {
  const { city, village, district, state, pincode } = addressParts(member);
  const attempts = [];
  if (village || city || district) {
    attempts.push({ params: { ...(village || city ? { city: village || city } : {}), ...(district ? { county: district } : {}), ...(state ? { state } : {}), ...(pincode ? { postalcode: pincode } : {}) }, precision: village ? 'village' : city ? 'city' : 'district' });
  }
  if (pincode) attempts.push({ params: { postalcode: pincode, ...(state ? { state } : {}) }, precision: 'pincode' });
  // A failed PIN must not silently fall back to an unrelated city or state.
  return attempts;
}

export function selectGeocodeHit(rows, member, precision) {
  const { state, pincode } = addressParts(member);
  const hits = (Array.isArray(rows) ? rows : []).flatMap((hit) => {
    const pair = coordinates(hit.lat, hit.lon);
    if (!pair || (hit.address?.country_code && hit.address.country_code !== 'in')) return [];
    const resultState = normaliseState(hit.address?.state);
    const resultPin = cleanPin(hit.address?.postcode);
    if (state && resultState && state !== resultState) return [];
    if (pincode && resultPin && pincode !== resultPin) return [];
    return [{ ...pair, precision, source: 'nominatim' }];
  });
  // Repeated village/city names without a state or PIN are ambiguous.
  if (!state && !pincode && hits.some((hit) => Math.abs(hit.lat - hits[0].lat) + Math.abs(hit.lng - hits[0].lng) > 0.5)) return null;
  return hits[0] || null;
}

export async function geocodeAddress(member, { db = pool, fetchImpl = fetch, deadline = Infinity, sleep = pause, useAI = false, aiLookup = locateAddressWithAi } = {}) {
  const parts = addressParts(member);
  const local = lookupIndianLocation({ ...parts, address: member.address });
  if (local) return local;
  if (!parts.can_geocode && !(useAI && parts.has_address)) return null;
  const key = cacheKey(member);
  const cached = await db.query(`SELECT lat, lng, precision, source, raw FROM geocode_cache
    WHERE query_key = $1 AND created_at > now() - CASE WHEN lat IS NULL THEN interval '7 days' ELSE interval '180 days' END`, [key]);
  if (cached.rows[0]) {
    const row = cached.rows[0];
    const pair = coordinates(row.lat, row.lng);
    if (pair) return { ...pair, precision: row.precision, source: row.source };
    if (!useAI || row.source === 'ai_geonames') return null;
  }
  let hit = null;
  if (useAI) {
    if (Date.now() + 8500 > deadline) { const error = new Error('Continue in the next batch'); error.code = 'BATCH_DEADLINE'; throw error; }
    hit = await aiLookup(member, { timeoutMs: 8000 });
    await db.query(`INSERT INTO geocode_cache (query_key,lat,lng,precision,source,raw)
      VALUES ($1,$2,$3,$4,'ai_geonames',$5::jsonb) ON CONFLICT (query_key) DO UPDATE
      SET lat=EXCLUDED.lat,lng=EXCLUDED.lng,precision=EXCLUDED.precision,source=EXCLUDED.source,raw=EXCLUDED.raw,created_at=now()`,
    [key, hit?.lat ?? null, hit?.lng ?? null, hit?.precision ?? null, hit ? JSON.stringify({ locality: hit.locality }) : null]);
    return hit;
  }
  for (const { params, precision } of searchAttempts(member)) {
    if (Date.now() + FETCH_TIMEOUT_MS + 1100 > deadline) {
      const error = new Error('Continue in the next batch'); error.code = 'BATCH_DEADLINE'; throw error;
    }
    // The caller holds an application-wide DB lock. Waiting before each network
    // call also enforces the rate across process restarts and adjacent batches.
    await sleep(1100);
    const url = `${endpoint()}?${new URLSearchParams({ format: 'jsonv2', countrycodes: 'in', limit: '5', addressdetails: '1', ...params })}`;
    const response = await fetchImpl(url, {
      headers: { 'User-Agent': `RGAccounts/1.0 (+${process.env.FRONTEND_URL || 'https://rgaccountbackend.onrender.com'})`, 'Accept-Language': 'en' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) {
      const error = new Error(`Location provider returned HTTP ${response.status}`);
      error.code = 'GEOCODER_UNAVAILABLE'; throw error;
    }
    const result = await response.json();
    if (!Array.isArray(result)) { const error = new Error('Invalid location provider response'); error.code = 'GEOCODER_UNAVAILABLE'; throw error; }
    hit = selectGeocodeHit(result, member, precision);
    if (hit) break;
  }
  // Network errors/timeouts are never negative-cached. Real misses expire too.
  await db.query(`INSERT INTO geocode_cache (query_key, lat, lng, precision, source)
    VALUES ($1,$2,$3,$4,'nominatim') ON CONFLICT (query_key) DO UPDATE
    SET lat=EXCLUDED.lat, lng=EXCLUDED.lng, precision=EXCLUDED.precision, source=EXCLUDED.source, raw=NULL, created_at=now()`,
  [key, hit?.lat ?? null, hit?.lng ?? null, hit?.precision ?? null]);
  return hit;
}

const snapshot = (member) => JSON.stringify(['address', 'city', 'village', 'district', 'state', 'pincode', 'permanent_address'].map((key) => member[key] ?? null));

export async function geocodePendingMembers({ siteId, limit = 100, afterId = 0, useAI = false }, { db = pool, lookup = geocodeAddress, loadAddresses = loadClientMapAddresses } = {}) {
  const cap = Math.min(Math.max(Math.trunc(Number(limit) || 100), 1), 300);
  const cursor = Math.max(0, Math.trunc(Number(afterId) || 0));
  const client = await db.connect();
  let locked = false;
  try {
    const lock = await client.query(`SELECT pg_try_advisory_lock(hashtext('client-map-geocoder')) AS locked`);
    locked = Boolean(lock.rows[0]?.locked);
    if (!locked) return { busy: true, processed: 0, geocoded: 0, next_after_id: cursor, message: 'An address lookup is already running. Try again shortly.' };
    const { rows } = await client.query(`SELECT id, address, permanent_address, city, village, district, state, pincode,
        latitude AS lat,longitude AS lng,geocode_source AS source FROM members
      WHERE site_id=$1 AND LOWER(BTRIM(COALESCE(status,'active'))) <> 'deleted'
        AND geocode_source IS DISTINCT FROM 'manual' AND ${NO_COORDINATES} ORDER BY id`, [siteId]);
    const resolved = await loadAddresses(rows, { db: client, siteId });
    const eligible = resolved.filter(row => !coordinates(row.lat, row.lng) && (addressParts(row).can_geocode || (useAI && addressParts(row).has_address)));
    const batch = eligible.filter((row) => Number(row.id) > cursor).slice(0, cap);
    const results = new Map();
    const deadline = Date.now() + BATCH_MS;
    let processed = 0, geocoded = 0, unmatched = 0, next = cursor, paused = false, failed = 0;
    for (const member of batch) {
      try {
        const key = cacheKey(member);
        if (!results.has(key)) results.set(key, await lookup(member, { db: client, deadline, useAI }));
        const hit = results.get(key);
        if (hit) {
          // KYC-derived and AI-normalized locations stay in the cache. They are
          // read afresh with the address, rather than overwriting profile pins.
          if (member.address_source === 'kyc' || hit.source === 'ai_geonames') {
            geocoded++; processed++; next = Number(member.id); continue;
          }
          // Compare the address snapshot and pin state: edits made while the
          // provider was responding must never be overwritten by stale results.
          const updated = await client.query(`UPDATE members SET latitude=$2, longitude=$3,
            geocode_source=$7, geocode_precision=$4, geocoded_at=now()
            WHERE id=$1 AND site_id=$5 AND geocode_source IS DISTINCT FROM 'manual'
              AND LOWER(BTRIM(COALESCE(status,'active'))) <> 'deleted' AND ${NO_COORDINATES}
              AND jsonb_build_array(address,city,village,district,state,pincode,permanent_address)=$6::jsonb`,
          [member.id, hit.lat, hit.lng, hit.precision, siteId, snapshot(rows.find(row => row.id === member.id) || member), hit.source || 'nominatim']);
          geocoded += updated.rowCount;
        } else unmatched++;
        processed++; next = Number(member.id);
      } catch (error) {
        paused = true;
        if (error.code !== 'BATCH_DEADLINE') failed++;
        break; // Keep this member eligible for retry; never skip a provider outage.
      }
    }
    const remaining = eligible.filter((row) => Number(row.id) > next).length;
    return { processed, geocoded, unmatched, failed, paused, remaining,
      next_after_id: remaining ? next : 0, has_more: remaining > 0,
      skipped_no_address: resolved.filter(row => !addressParts(row).has_address).length };
  } finally {
    try { if (locked) await client.query(`SELECT pg_advisory_unlock(hashtext('client-map-geocoder'))`); }
    catch (error) { client.release(error); throw error; }
    client.release();
  }
}
