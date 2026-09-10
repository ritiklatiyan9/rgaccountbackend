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

// Tests and migration runners re-probe after creating the object.
export const forgetRelationProbes = () => probes.clear();
