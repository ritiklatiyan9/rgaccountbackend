/** Registry consideration is the displayed Size (m²) multiplied by Circle Rate. */
export const registryPaymentFromMetres = (metres, circleRate) => {
  const area = Number(metres);
  const rate = Number(circleRate);
  if (!Number.isFinite(area) || !Number.isFinite(rate) || area <= 0 || rate <= 0) return null;
  return Math.round(area * rate * 100) / 100;
};

/** Registry m² is always Gaz × 0.8364 — never copied from the plot's stored metres. */
export const registryMetresFromGaz = (gaz) => {
  const area = Number(gaz);
  return Number.isFinite(area) && area > 0 ? Math.round(area * 0.8364 * 100) / 100 : null;
};
