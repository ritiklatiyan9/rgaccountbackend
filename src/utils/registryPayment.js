/** Registry consideration is the displayed Size (m²) multiplied by Circle Rate. */
export const registryPaymentFromMetres = (metres, circleRate) => {
  const area = Number(metres);
  const rate = Number(circleRate);
  if (!Number.isFinite(area) || !Number.isFinite(rate) || area <= 0 || rate <= 0) return null;
  return Math.round(area * rate * 100) / 100;
};

/** Fallback for an unlinked registry; linked plots use Plot Payments' stored metres. */
export const registryMetresFromGaz = (gaz) => {
  const area = Number(gaz);
  return Number.isFinite(area) && area > 0 ? Number((area * 0.8364).toFixed(4)) : null;
};
