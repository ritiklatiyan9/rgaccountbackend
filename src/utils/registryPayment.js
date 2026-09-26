/** Registry consideration is Gaz (square yards) multiplied by Circle Rate. */
export const registryPaymentFromGaz = (gaz, circleRate) => {
  const area = Number(gaz);
  const rate = Number(circleRate);
  if (!Number.isFinite(area) || !Number.isFinite(rate) || area <= 0 || rate <= 0) return null;
  return Math.round(area * rate * 100) / 100;
};
