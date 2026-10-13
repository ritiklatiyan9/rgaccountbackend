const positive = value => Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : null;
const metresFromArea = (size, unitType) => Number((size * (unitType === 'flat' ? 0.09290304 : 0.8364)).toFixed(4));

// Plot Payments owns the bank target. Preserve paise and explicit zero values.
export function registryFinanceFromPlot(plot) {
  return {
    ...(Object.hasOwn(plot, 'to_receive_bank') ? {
      bank_amount: Number(plot.to_receive_bank) || 0,
      registry_payment: Number(plot.to_receive_bank) || 0,
    } : {}),
    ...(Object.hasOwn(plot, 'circle_rate') ? { circle_rate: Number(plot.circle_rate) || 0 } : {}),
  };
}

export function registrySizeFromPlot(plot) {
  const size = positive(plot?.plot_size);
  const gaz = size == null ? null : plot.unit_type === 'flat' ? Number((size / 9).toFixed(4)) : size;
  return {
    size_sqyard: gaz,
    size_meter: positive(plot?.plot_size_mtr) ?? (size == null ? null : metresFromArea(size, plot?.unit_type)),
  };
}

export function normalizeRegistrySize(registry) {
  if (!registry || !registry.size_source_plot_id) return registry;
  const { source_plot_size, source_plot_size_mtr, source_unit_type, source_to_receive_bank, source_circle_rate, ...rest } = registry;
  const finance = registryFinanceFromPlot({
    ...(Object.hasOwn(registry, 'source_to_receive_bank') ? { to_receive_bank: source_to_receive_bank } : {}),
    ...(Object.hasOwn(registry, 'source_circle_rate') ? { circle_rate: source_circle_rate } : {}),
  });
  return { ...rest, ...registrySizeFromPlot({ plot_size: source_plot_size, plot_size_mtr: source_plot_size_mtr, unit_type: source_unit_type }), ...finance };
}
