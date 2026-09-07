import { allocateInstallmentPayments } from './installmentAllocation.service.js';

const round = (value) => Math.round((Number(value) || 0) * 100) / 100;
const invalid = (message) => Object.assign(new Error(message), { statusCode: 400 });
export const todayInIndia = () => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date());

export const validPlanDate = (value) => typeof value === 'string'
  && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && value >= '1900-01-01' && value <= '2100-12-31'
  && !Number.isNaN(Date.parse(value))
  && new Date(value).toISOString().slice(0, 10) === value;

/** Calendar months from booking, clamped to the last day of the target month. */
export function addBookingMonths(bookingDate, months) {
  const [year, month, day] = bookingDate.split('-').map(Number);
  const target = new Date(Date.UTC(year, month - 1 + months, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, last));
  return target.toISOString().slice(0, 10);
}

/** Convert cumulative percentages to incremental installments; never compound them. */
export function buildPercentagePlan({ bookingDate, salePrice, milestones }) {
  if (!validPlanDate(bookingDate)) throw invalid('Set a valid booking date on the plot first.');
  const valuePaise = Math.round(Number(salePrice) * 100);
  if (!Number.isSafeInteger(valuePaise) || valuePaise <= 0) throw invalid('Set a positive sale value on the plot first.');
  if (!Array.isArray(milestones) || !milestones.length || milestones.length > 60) {
    throw invalid('Add between 1 and 60 payment milestones.');
  }
  let previousMonths = -1;
  let previousPercent = 0;
  let previousPaise = 0;
  return milestones.map((milestone, index) => {
    if (!milestone || typeof milestone !== 'object') throw invalid('Each milestone needs months and a required percentage.');
    const months = Number(milestone.months);
    const percent = Number(milestone.percent);
    if (milestone.months === '' || milestone.months == null || !Number.isInteger(months)
      || months < 0 || months > 600 || months <= previousMonths) {
      throw invalid('Months must increase in each milestone, starting at 0 or later.');
    }
    if (!Number.isFinite(percent) || percent <= previousPercent || percent > 100) {
      throw invalid('Required percentages must increase in each milestone, up to 100%.');
    }
    const cumulativePaise = Math.round(valuePaise * percent / 100);
    const amount = (cumulativePaise - previousPaise) / 100;
    const dueDate = addBookingMonths(bookingDate, months);
    if (amount <= 0 || !validPlanDate(dueDate)) throw invalid('Each milestone needs a positive amount and a due date before 2101.');
    previousMonths = months;
    previousPercent = percent;
    previousPaise = cumulativePaise;
    return {
      installment_name: `${percent}% by month ${months}`,
      amount, due_date: dueDate, sort_order: index + 1, required_percent: percent,
    };
  });
}

export function validatePendingFilters({ dateFrom, dateTo, asOf, today }) {
  for (const value of [today, dateFrom, dateTo, asOf]) {
    if (!validPlanDate(value)) throw invalid('Use valid dates in YYYY-MM-DD format.');
  }
  if (dateFrom > dateTo) throw invalid('From date cannot be after To date.');
  if (asOf < today) throw invalid('The due-by date must be today or a future date.');
}

const groupByPlot = (rows) => {
  const grouped = new Map();
  for (const row of rows) {
    const id = String(row.plot_id);
    if (!grouped.has(id)) grouped.set(id, []);
    grouped.get(id).push(row);
  }
  return grouped;
};

/** Read-only projection using receipts already posted as of today. Each row is
 * one installment's unpaid portion, so summing a period cannot repeat arrears. */
export function buildPendingPaymentReport({
  plots, installments, receipts, today, dateFrom, dateTo, asOf, broker = '', search = '',
}) {
  validatePendingFilters({ today, dateFrom, dateTo, asOf });
  const instByPlot = groupByPlot(installments);
  const payByPlot = groupByPlot(receipts);
  const active = plots.filter((plot) => !['COMPANY', 'AVAILABLE', 'CANCEL', 'CANCELLED', 'TRANSFERRED'].includes(String(plot.status || '').toUpperCase())
    && String(plot.plot_tag || '').trim().toUpperCase() !== 'OLD');
  const brokers = [...new Set(active.map((plot) => String(plot.booking_by || '').trim()).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b));
  const term = search.trim().toLowerCase();
  const scoped = active.filter((plot) => (!broker || (broker === '__unassigned__'
    ? !String(plot.booking_by || '').trim() : String(plot.booking_by || '').trim() === broker))
    && (!term || [plot.plot_no, plot.block, plot.buyer_name, plot.booking_by].some((value) => String(value || '').toLowerCase().includes(term))));
  const rows = [];
  const needsPlan = [];
  for (const plot of scoped) {
    const id = String(plot.id);
    const schedule = [...(instByPlot.get(id) || [])].sort((a, b) => Number(a.sort_order) - Number(b.sort_order)
      || a.due_date.localeCompare(b.due_date) || Number(a.id) - Number(b.id));
    let genericPaid = 0;
    let totalReceived = 0;
    const directPaidByInstallment = {};
    for (const receipt of payByPlot.get(id) || []) {
      const amount = round(receipt.amount);
      totalReceived += amount;
      if (receipt.installment_id == null) genericPaid += amount;
      else directPaidByInstallment[receipt.installment_id] = round((directPaidByInstallment[receipt.installment_id] || 0) + amount);
    }
    totalReceived = round(totalReceived);
    const value = round(plot.sale_price);
    const common = {
      plot_id: plot.id, plot_no: plot.plot_no, block: plot.block,
      customer_name: plot.buyer_name || '', broker: String(plot.booking_by || '').trim(),
      booking_date: plot.booking_date, total_plot_value: value, payment_received: totalReceived,
    };
    const scheduled = round(schedule.reduce((sum, row) => sum + Number(row.amount), 0));
    if (value > totalReceived && (schedule.length === 0 || scheduled < value)) {
      needsPlan.push({ ...common, has_schedule: schedule.length > 0,
        unscheduled_amount: round(Math.max(value - Math.max(scheduled, totalReceived), 0)),
        reason: schedule.length ? 'Part of the plot value has no due date' : 'No payment plan',
      });
    }
    const allocated = allocateInstallmentPayments(schedule, {
      genericPaid, directPaidByInstallment, asOf: `${today}T00:00:00Z`,
    }).installments;
    let cumulative = 0;
    for (const installment of allocated) {
      cumulative = round(cumulative + Number(installment.amount));
      const remaining = round(installment.remaining);
      if (remaining <= 0) continue;
      rows.push({ ...common, installment_id: installment.id,
        installment_name: installment.installment_name,
        required_percent: value > 0 ? round(cumulative / value * 100) : null,
        required_amount: cumulative, installment_amount: round(installment.amount),
        installment_received: round(installment.paid), pending_amount: remaining,
        due_date: installment.due_date,
        payment_status: installment.due_date < today ? 'overdue' : installment.due_date === today ? 'due_today' : 'upcoming',
      });
    }
  }
  rows.sort((a, b) => a.due_date.localeCompare(b.due_date)
    || String(a.plot_no).localeCompare(String(b.plot_no), undefined, { numeric: true }) || a.installment_id - b.installment_id);
  const current = rows.filter((row) => row.due_date <= today);
  const period = rows.filter((row) => row.due_date >= dateFrom && row.due_date <= dateTo);
  const upcoming = period.filter((row) => row.due_date > today);
  const dueBy = rows.filter((row) => row.due_date <= asOf);
  const sum = (list) => round(list.reduce((amount, row) => amount + row.pending_amount, 0));
  return {
    today, date_from: dateFrom, date_to: dateTo, as_of: asOf, brokers,
    rows, needs_plan: needsPlan,
    summary: {
      pending_today: sum(current), pending_plot_count: new Set(current.map((row) => row.plot_id)).size,
      expected_in_period: sum(period), upcoming_in_period: sum(upcoming),
      due_by_date: sum(dueBy), period_installment_count: period.length,
      needs_plan_count: needsPlan.length,
    },
  };
}
