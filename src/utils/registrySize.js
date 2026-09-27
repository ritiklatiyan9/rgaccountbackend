const positive = value => Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : null;

export function registrySizeFromPlot(plot) {
  const size = positive(plot?.plot_size);
  const gaz = size == null ? null : plot.unit_type === 'flat' ? Number((size / 9).toFixed(4)) : size;
  return {
    size_sqyard: gaz,
    size_meter: positive(plot?.plot_size_mtr) ?? (gaz == null ? null : Math.round(gaz * 0.8364 * 100) / 100),
  };
}

export function normalizeRegistrySize(registry) {
  if (!registry || !registry.size_source_plot_id) return registry;
  const { source_plot_size, source_plot_size_mtr, source_unit_type, ...rest } = registry;
  return { ...rest, ...registrySizeFromPlot({ plot_size: source_plot_size, plot_size_mtr: source_plot_size_mtr, unit_type: source_unit_type }) };
}
