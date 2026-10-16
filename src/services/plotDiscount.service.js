// A plot has either a per-area discount or an exact total rupee discount.
// Clearing the other field also keeps older booking clients compatible.
export function plotDiscountForWrite(body) {
  const result = {};
  for (const field of ['discount_rate', 'discount_amount']) {
    if (body[field] === undefined) continue;
    const value = body[field] === '' || body[field] == null ? 0 : Number(body[field]);
    if (!Number.isFinite(value) || value < 0) {
      throw Object.assign(new Error('Discount must be a valid amount of zero or more.'), { statusCode: 400 });
    }
    result[field] = Number(value.toFixed(2));
  }
  if (result.discount_amount > 0 && result.discount_rate > 0) {
    throw Object.assign(new Error('Choose a per-area discount or a total rupee discount.'), { statusCode: 400 });
  }
  if (Object.hasOwn(result, 'discount_rate') && body.discount_amount === undefined) result.discount_amount = 0;
  if (result.discount_amount > 0) result.discount_rate = 0;
  return result;
}
