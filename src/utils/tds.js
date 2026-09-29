// Pure TDS rules shared by the register and its tests. No database access.
export const TDS_SECTIONS = Object.freeze(['192', '194C', '194H', '194I', '194IA', '194J', '194Q', 'OTHER']);

const PAN = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
const invalid = (message) => { throw Object.assign(new Error(message), { statusCode: 400 }); };
const money = (value) => Math.round(Number(value) * 100) / 100;

export const validDate = (value) => {
  const text = String(value || '');
  return /^\d{4}-\d{2}-\d{2}$/.test(text) && !Number.isNaN(Date.parse(text))
    && new Date(text).toISOString().slice(0, 10) === text ? text : null;
};

// Rule 30: deposit by the 7th of the next month; March deductions by 30 April.
export const tdsDueDate = (date) => {
  const [year, month] = date.split('-').map(Number);
  return month === 3 ? `${year}-04-30` : new Date(Date.UTC(year, month, 7)).toISOString().slice(0, 10);
};

export const TDS_FIELDS = Object.freeze(['member_id', 'deductee_name', 'pan', 'aadhaar', 'section', 'deduction_date',
  'gross_amount', 'tds_rate', 'tds_amount', 'nature', 'deposit_date', 'challan_no', 'notes']);

export function parseDeduction(body) {
  const name = String(body.deductee_name ?? '').trim().slice(0, 200);
  if (!name) invalid('Deductee name is required.');
  const pan = String(body.pan ?? '').trim().toUpperCase() || null;
  if (pan && !PAN.test(pan)) invalid('PAN must look like ABCDE1234F.');
  const aadhaar = String(body.aadhaar ?? '').replace(/\D/g, '') || null;
  if (aadhaar && aadhaar.length !== 12) invalid('Aadhaar must have 12 digits.');
  if (!TDS_SECTIONS.includes(body.section)) invalid('Choose a TDS section.');
  const date = validDate(body.deduction_date);
  if (!date) invalid('Enter a valid deduction date.');
  const gross = money(body.gross_amount);
  if (!(gross > 0 && gross < 1e12)) invalid('Gross amount must be more than zero.');
  const rate = Number(body.tds_rate);
  if (body.tds_rate === '' || !(rate >= 0 && rate <= 100)) invalid('TDS rate must be between 0 and 100.');
  const tds = money(body.tds_amount);
  if (body.tds_amount === '' || !(tds >= 0 && tds <= gross)) invalid('TDS amount must be between zero and the gross amount.');
  const deposit = body.deposit_date ? validDate(body.deposit_date) : null;
  if (body.deposit_date && !deposit) invalid('Enter a valid deposit date.');
  if (deposit && deposit < date) invalid('Deposit date cannot be before the deduction date.');
  const memberId = body.member_id == null || body.member_id === '' ? null : Number(body.member_id);
  if (memberId !== null && !(Number.isSafeInteger(memberId) && memberId > 0)) invalid('Choose a valid member.');
  return {
    member_id: memberId, deductee_name: name, pan, aadhaar, section: body.section, deduction_date: date,
    gross_amount: gross, tds_rate: rate, tds_amount: tds, nature: String(body.nature ?? '').trim().slice(0, 200),
    deposit_date: deposit, challan_no: String(body.challan_no ?? '').trim().slice(0, 40) || null,
    notes: String(body.notes ?? '').trim().slice(0, 2000),
  };
}
