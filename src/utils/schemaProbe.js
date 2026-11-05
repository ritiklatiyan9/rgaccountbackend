import pool from '../config/db.js';

// Not every database this backend is pointed at has run every migration.
// A read path probes once for the object it needs and degrades instead of
// answering 500 — the memoized pattern already used by _resolveGracePeriodCol
// in plot.controller.js and _resolveHandoverTableOnce in PlotRegistry.model.js,
// shared here because three endpoints now need it.
//
// The promise itself is cached, so concurrent first calls issue one query.
// Missing objects are checked again on the next read, so running a migration
// restores notifications without a process restart. Successful probes stay cached.
const probes = new Map();

export function hasRelation(name) {
  if (!probes.has(name)) {
    probes.set(name, pool
      .query('SELECT to_regclass($1) IS NOT NULL AS present', [`public.${name}`])
      .then(({ rows }) => !!rows[0]?.present)
      .catch(() => false)
      .then(present => {
        if (!present) probes.delete(name);
        return present;
      }));
  }
  return probes.get(name);
}

/** Warm a read surface's optional relations in one round trip, sharing probes. */
export async function hasRelations(names) {
  const unique = [...new Set(names)];
  const missing = unique.filter(name => !probes.has(name));
  if (missing.length) {
    const pending = pool.query(`SELECT name,to_regclass('public.' || name) IS NOT NULL AS present
      FROM unnest($1::text[]) AS names(name)`, [missing])
      .then(({ rows }) => new Map(rows.map(row => [row.name, row.present === true])))
      .catch(() => new Map());
    for (const name of missing) {
      probes.set(name, pending.then(result => {
        const present = result.get(name) === true;
        if (!present) probes.delete(name);
        return present;
      }));
    }
  }
  return new Map(await Promise.all(unique.map(async name => [name, await probes.get(name)])));
}

// Tests and migration runners re-probe after creating the object.
export const forgetRelationProbes = () => probes.clear();
