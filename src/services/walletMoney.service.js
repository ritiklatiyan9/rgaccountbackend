// Monetary arithmetic stays in integer paise. SQL NUMERIC may retain harmless
// trailing zeroes; reject sub-paise values rather than silently rounding money.
export function walletMinor(value) {
  const match=/^(-?)(\d+)(?:\.(\d+))?$/.exec(String(value??'').trim());
  const fraction=match?.[3]?.replace(/0+$/,'')||'';
  if(!match||fraction.length>2) throw new TypeError('Invalid exact wallet amount.');
  return (BigInt(match[2])*100n+BigInt(fraction.padEnd(2,'0')))*(match[1]?-1n:1n);
}
export function walletDecimal(value) {
  const amount=value<0n?-value:value;
  return `${value<0n?'-':''}${amount/100n}.${String(amount%100n).padStart(2,'0')}`;
}
export const sumWalletMoney=values=>walletDecimal(values.reduce((total,value)=>total+walletMinor(value),0n));
