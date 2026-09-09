import pool from '../config/db.js';

// Not every database this backend is pointed at has run every migration.
// A read path probes once for the object it needs and degrades instead of
// answering 500 — the memoized pattern already used by _resolveGracePeriodCol
// in plot.controller.js and _resolveHandoverTableOnce in PlotRegistry.model.js,
// shared here because three endpoints now need it.
//
// The promise itself is cached, so concurrent first calls issue one query.
// A process restart re-probes, which is how a freshly run migration is picked up.
const probes = new Map();

export function hasRelation(name) {
  if (!probes.has(name)) {
    probes.set(name, pool
      .query('SELECT to_regclass($1) IS NOT NULL AS present', [`public.${name}`])
      .then(({ rows }) => !!rows[0]?.present)
      .catch(() => false));
  }
  return probes.get(name);
}

// Tests and migration runners re-probe after creating the object.
export const forgetRelationProbes = () => probes.clear();
