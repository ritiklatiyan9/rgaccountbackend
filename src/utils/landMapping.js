// Land Sale ↔ Land Purchase mapping maths.
//
// A purchase is a `farmers` row (the land we bought: area + total_amount). A sale is a
// `land_deals` row cut from that land via farmer_id. One land can be sold in several
// pieces, so every sale carries the slice of the purchase price it consumes
// (`purchase_cost`) and the profit of a piece is  sale − its cost share − other cost.
const num = (v) => Number(v) || 0;
const money = (v) => Math.round(num(v) * 100) / 100;
const live = (sales) => sales.filter((s) => s.status !== 'cancelled');
const fmt = (v) => num(v).toLocaleString('en-IN', { maximumFractionDigits: 2 });

/** The unit a land is measured in. Gaz wins because every sale with an area carries gaz. */
export const landUnit = (farmer) => (num(farmer.land_size_gaz) > 0 ? 'gaz' : num(farmer.land_size_bigha) > 0 ? 'bigha' : null);
export const landArea = (farmer) => {
  const unit = landUnit(farmer);
  return unit === 'gaz' ? num(farmer.land_size_gaz) : unit === 'bigha' ? num(farmer.land_size_bigha) : 0;
};
const saleArea = (sale, unit) => num(unit === 'gaz' ? sale.area_gaz : sale.area_bigha);

/** Area already sold from a land, in the land's unit (0 when the land has no area recorded). */
export const soldArea = (farmer, sales) => {
  const unit = landUnit(farmer);
  return unit ? live(sales).reduce((sum, s) => sum + saleArea(s, unit), 0) : 0;
};
export const remainingArea = (farmer, sales) => Math.max(landArea(farmer) - soldArea(farmer, sales), 0);

/** Purchase-price share of one sale: by area when the land has one, else whatever is still unallocated. */
export const allocateCost = (farmer, otherSales, sale) => {
  const total = num(farmer.total_amount);
  const unit = landUnit(farmer);
  const area = unit ? saleArea(sale, unit) : 0;
  if (unit && area > 0) return money(Math.min(total, (total * area) / landArea(farmer)));
  const allocated = live(otherSales).reduce((sum, s) => sum + num(s.purchase_cost), 0);
  return money(Math.max(total - allocated, 0));
};

/** Null when the sale fits in what is left of the land, else the message to show the user. */
export const overSold = (farmer, otherSales, sale) => {
  const unit = landUnit(farmer);
  if (!unit || sale.status === 'cancelled') return null;
  const area = saleArea(sale, unit);
  if (!(area > 0)) return null;
  const left = remainingArea(farmer, otherSales);
  if (area <= left + 1e-6) return null;
  return `Only ${fmt(left)} ${unit} of this land is left to sell (${fmt(landArea(farmer))} ${unit} bought, ${fmt(soldArea(farmer, otherSales))} sold)`;
};

/** paying → held (farmer fully paid, nothing sold) → partly_sold → sold. */
export const landStage = (farmer, sales, paid) => {
  if (live(sales).length === 0) return num(farmer.total_amount) > 0 && num(paid) >= num(farmer.total_amount) - 0.005 ? 'held' : 'paying';
  return landUnit(farmer) && remainingArea(farmer, sales) > 1e-6 ? 'partly_sold' : 'sold';
};
