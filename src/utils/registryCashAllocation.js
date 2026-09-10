// Manual CASH declares how much previously received cash covers the registry.
// It is not a new receipt. When present, it replaces the linked cash component
// for registry coverage; adding both would count the same money twice.
export const registryCashAllocationSql = `(prp.source_plot_payment_id IS NULL
  AND COALESCE(NULLIF(UPPER(TRIM(prp.payment_mode)), ''), 'CASH') = 'CASH')`;
const cash = `(CASE WHEN prp.source_plot_payment_id IS NULL
  THEN COALESCE(NULLIF(UPPER(TRIM(prp.payment_mode)), ''), 'CASH')
  ELSE COALESCE(NULLIF(UPPER(TRIM(pp.payment_type)), ''), 'CASH') END = 'CASH')`;
export const registryCoverageSql = `(COALESCE(SUM(prp.amount) FILTER (WHERE NOT ${cash}), 0)
  + CASE WHEN COUNT(*) FILTER (WHERE ${registryCashAllocationSql} AND prp.amount > 0) > 0
    THEN COALESCE(SUM(prp.amount) FILTER (WHERE ${registryCashAllocationSql}), 0)
    ELSE COALESCE(SUM(prp.amount) FILTER (WHERE ${cash}), 0) END)`;
