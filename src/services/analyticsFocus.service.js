// Topic routing for the Management Analytics copilot.
// The site snapshot is whole-site aggregates; a question about ONE module (farmers, vendors…)
// needs that module's rows. detectTopics() maps the question to modules, buildFocus() fetches a
// compact per-module slice (top-N rows, names only, no phone/aadhaar/bank), and localAnswer()
// gives a deterministic answer for the same topic when the model is unavailable.
import pool from '../config/db.js';
import { cleanText } from './openRouterStream.service.js';

const TOPIC_WORDS = {
  farmers: ['farmer', 'farmers', 'kisan', 'kisaan', 'किसान', 'land owner', 'landowner', 'zameen', 'जमीन', 'bigha', 'बीघा'],
  vendors: ['vendor', 'vendors', 'contractor', 'thekedar', 'ठेकेदार', 'supplier', 'commitment', 'inventory', 'material', 'साम', 'samaan'],
  construction: ['construction', 'project', 'projects', 'project progress', 'delayed project', 'site work', 'निर्माण', 'nirman'],
  commissions: ['commission', 'commissions', 'agent', 'agents', 'broker', 'dalal', 'दलाल', 'कमीशन', 'payout', 'booking by'],
  expenses: ['expense', 'expenses', 'kharcha', 'kharch', 'खर्च', 'spend', 'spending', 'cost', 'costs', 'paid to', 'category'],
  imprest: ['imprest', 'petty cash', 'float', 'advance', 'एडवांस'],
  registries: ['registry', 'registries', 'noc', 'रजिस्ट्री', 'registered'],
  approvals: ['approval', 'approvals', 'pending approval', 'approve', 'cheque', 'cheques', 'चेक', 'bounce', 'bounced'],
  timing: ['which day', 'which days', 'what day', 'best day', 'best days', 'day of', 'days of', 'day of month', 'weekday', 'probability', 'likely', 'chance', 'when do', 'when does', 'kab', 'kis din', 'kaunse din', 'konse din', 'din', 'दिन', 'तारीख', 'tarikh', 'timing', 'pattern', 'cycle'],
  plots: ['plot', 'plots', 'buyer', 'buyers', 'client', 'clients', 'customer', 'customers', 'grahak', 'ग्राहक', 'प्लॉट', 'receivable', 'outstanding', 'due', 'baaki', 'बाकी', 'collection', 'collections', 'payment', 'payments', 'installment'],
};

/** @returns {string[]} topics found in the question, most specific first; [] when none matched. */
export const detectTopics = (question) => {
  const q = ` ${String(question || '').toLowerCase()} `;
  const hits = [];
  for (const [topic, words] of Object.entries(TOPIC_WORDS)) {
    if (words.some((w) => q.includes(w))) hits.push(topic);
  }
  // 'plots' has generic words (payment/due) — only keep it as a fallback when nothing more specific matched.
  if (hits.length > 1 && hits.includes('plots')) return hits.filter((t) => t !== 'plots');
  // 'timing' is about WHEN money comes in; plot/payment words in the same question are context, not a second topic.
  if (hits.includes('timing')) return ['timing'];
  return hits;
};

const num = (v) => Number(v) || 0;
const r0 = (v) => Math.round(num(v));
const q = async (sql, params) => (await pool.query(sql, params)).rows;

const FOCUS_SQL = {
  farmers: async (siteId) => {
    const rows = await q(`
      WITH paid AS (
        SELECT fp.farmer_id, SUM(l.debit) AS paid, COUNT(*) FILTER (WHERE l.debit > 0) AS payments, MAX(l.entry_date) AS last_payment
          FROM ledger_entries l JOIN farmer_payments fp ON fp.id = l.source_id
         WHERE l.site_id = $1 AND l.source_key = 'farmer_payments' GROUP BY fp.farmer_id)
      SELECT f.name, f.status, f.land_size_bigha, f.land_rate, f.total_amount AS liability,
             COALESCE(p.paid,0) AS paid, f.total_amount - COALESCE(p.paid,0) AS outstanding,
             COALESCE(p.payments,0)::int AS payments, p.last_payment
        FROM farmers f LEFT JOIN paid p ON p.farmer_id = f.id
       WHERE f.site_id = $1
       ORDER BY (f.total_amount - COALESCE(p.paid,0)) DESC, f.name LIMIT 25`, [siteId]);
    const list = rows.map((r) => ({
      name: cleanText(r.name, 60), status: r.status, land_bigha: num(r.land_size_bigha) || null, rate: r0(r.land_rate) || null,
      liability: r0(r.liability), paid: r0(r.paid), outstanding: r0(r.outstanding), payments: r.payments,
      last_payment: r.last_payment ? new Date(r.last_payment).toISOString().slice(0, 10) : null,
    }));
    const tot = list.reduce((a, r) => ({ liability: a.liability + r.liability, paid: a.paid + r.paid }), { liability: 0, paid: 0 });
    return {
      note: 'Farmers = land sellers the company owes money to. liability = agreed land amount; paid = approved payments on the ledger; outstanding = still to pay. Sorted by outstanding.',
      count: list.length, liability_total: tot.liability, paid_total: tot.paid, outstanding_total: tot.liability - tot.paid,
      fully_paid: list.filter((r) => r.outstanding <= 0).length, farmers: list,
    };
  },
  vendors: async (siteId) => {
    const rows = await q(`
      WITH paid AS (
        SELECT vp.commitment_id, SUM(l.debit) AS paid, MAX(l.entry_date) AS last_payment
          FROM ledger_entries l JOIN vendor_payments vp ON vp.id = l.source_id
         WHERE l.site_id = $1 AND l.source_key = 'vendor_payments' GROUP BY vp.commitment_id)
      SELECT vc.vendor_name, vc.work_title, vc.head_name, vc.status, vc.due_date, vc.contract_amount,
             COALESCE(p.paid,0) AS paid, vc.contract_amount - COALESCE(p.paid,0) AS outstanding, p.last_payment
        FROM vendor_commitments vc LEFT JOIN paid p ON p.commitment_id = vc.id
       WHERE vc.site_id = $1
       ORDER BY (vc.status = 'open') DESC, (vc.contract_amount - COALESCE(p.paid,0)) DESC LIMIT 20`, [siteId]);
    const orders = await q(`SELECT status, COUNT(*)::int AS count, COALESCE(SUM(net_amount),0) AS net, COALESCE(SUM(total_paid),0) AS paid
                              FROM vendor_inventory_orders WHERE site_id = $1 GROUP BY 1`, [siteId]).catch(() => []);
    return {
      note: 'Vendors = contractors/suppliers with work commitments. outstanding = contract amount minus approved payments.',
      commitments: rows.map((r) => ({
        vendor: cleanText(r.vendor_name, 60), work: cleanText(r.work_title, 80), head: cleanText(r.head_name, 40), status: r.status,
        due_date: r.due_date ? new Date(r.due_date).toISOString().slice(0, 10) : null, contract: r0(r.contract_amount), paid: r0(r.paid), outstanding: r0(r.outstanding),
      })),
      inventory_orders: orders.map((o) => ({ status: o.status, count: o.count, net: r0(o.net), paid: r0(o.paid) })),
    };
  },
  commissions: async (siteId) => {
    const rows = await q(`
      WITH paid AS (
        SELECT pcp.plot_commission_id, SUM(l.debit) AS paid FROM ledger_entries l
          JOIN plot_commission_payments pcp ON pcp.id = l.source_id
         WHERE l.site_id = $1 AND l.source_key = 'plot_commission_payments' GROUP BY pcp.plot_commission_id)
      SELECT m.full_name AS agent, COUNT(DISTINCT pc.plot_id)::int AS plots,
             SUM(pc.total_commission) AS decided, COALESCE(SUM(p.paid),0) AS paid,
             SUM(pc.total_commission) - COALESCE(SUM(p.paid),0) AS pending
        FROM plot_commissions_v2 pc JOIN members m ON m.id = pc.agent_id LEFT JOIN paid p ON p.plot_commission_id = pc.id
       WHERE pc.site_id = $1 GROUP BY m.full_name ORDER BY pending DESC LIMIT 20`, [siteId]);
    return {
      note: 'Commission per agent (broker). decided = commission assigned on their plots; paid = approved payouts; pending = still to pay.',
      agents: rows.map((r) => ({ agent: cleanText(r.agent, 60), plots: r.plots, decided: r0(r.decided), paid: r0(r.paid), pending: r0(r.pending) })),
    };
  },
  expenses: async (siteId, { from, to }) => {
    const P = [siteId, from, to];
    const W = `l.site_id = $1 AND l.source_key = 'expenses' AND l.debit <> 0 AND l.entry_date >= $2::date AND l.entry_date <= LEAST($3::date, CURRENT_DATE)`;
    const [cats, payees, largest, recent] = await Promise.all([
      q(`SELECT COALESCE(NULLIF(TRIM(e.category),''),'Uncategorised') AS category, SUM(l.debit) AS amount, COUNT(*)::int AS count
           FROM ledger_entries l JOIN expenses e ON e.id = l.source_id WHERE ${W} GROUP BY 1 ORDER BY 2 DESC LIMIT 15`, P),
      q(`SELECT COALESCE(NULLIF(TRIM(e.to_entity),''),'—') AS payee, SUM(l.debit) AS amount, COUNT(*)::int AS count
           FROM ledger_entries l JOIN expenses e ON e.id = l.source_id WHERE ${W} GROUP BY 1 ORDER BY 2 DESC LIMIT 12`, P),
      q(`SELECT l.entry_date, e.to_entity, e.category, l.debit AS amount, e.payment_mode
           FROM ledger_entries l JOIN expenses e ON e.id = l.source_id WHERE ${W} ORDER BY l.debit DESC LIMIT 8`, P),
      q(`SELECT COALESCE(SUM(l.debit),0) AS last_30d FROM ledger_entries l
          WHERE l.site_id = $1 AND l.source_key = 'expenses' AND l.entry_date >= CURRENT_DATE - 30 AND l.entry_date <= CURRENT_DATE`, [siteId]),
    ]);
    return {
      note: `Expenses for ${from} to ${to} (approved ledger rows).`,
      last_30_days: r0(recent[0]?.last_30d),
      by_category: cats.map((c) => ({ category: cleanText(c.category, 40), amount: r0(c.amount), count: c.count })),
      top_payees: payees.map((p) => ({ payee: cleanText(p.payee, 50), amount: r0(p.amount), count: p.count })),
      largest: largest.map((e) => ({ date: new Date(e.entry_date).toISOString().slice(0, 10), payee: cleanText(e.to_entity, 50), category: cleanText(e.category, 40), amount: r0(e.amount), mode: e.payment_mode })),
    };
  },
  imprest: async (siteId) => {
    const rows = await q(`
      SELECT u.name, il.balance_after, il.created_at
        FROM (SELECT DISTINCT ON (user_id) user_id, balance_after, created_at FROM imprest_ledger WHERE site_id = $1 ORDER BY user_id, created_at DESC) il
        JOIN users u ON u.id = il.user_id ORDER BY il.balance_after DESC LIMIT 15`, [siteId]);
    return { note: 'Imprest = petty-cash float held by staff; balance = amount currently with the holder.', holders: rows.map((r) => ({ holder: cleanText(r.name, 50), balance: r0(r.balance_after), as_of: new Date(r.created_at).toISOString().slice(0, 10) })) };
  },
  registries: async (siteId) => {
    const [tot, pending] = await Promise.all([
      q(`SELECT COUNT(*)::int AS count, COUNT(*) FILTER (WHERE noc_generated_at IS NOT NULL)::int AS noc_generated,
                COALESCE(SUM(registry_payment),0) AS registry_payment_total FROM plot_registries WHERE site_id = $1`, [siteId]),
      q(`SELECT plot_no, customer_name, registry_date FROM plot_registries WHERE site_id = $1 AND noc_generated_at IS NULL
          ORDER BY registry_date DESC NULLS LAST LIMIT 12`, [siteId]),
    ]);
    return { ...tot[0], registry_payment_total: r0(tot[0]?.registry_payment_total), noc_pending: pending.map((r) => ({ plot_no: r.plot_no, customer: cleanText(r.customer_name, 50), registry_date: r.registry_date ? new Date(r.registry_date).toISOString().slice(0, 10) : null })) };
  },
  construction: async (siteId) => {
    const [projects, tasks, requests] = await Promise.all([
      q(`SELECT p.name, p.code, p.status, p.progress_pct, p.budget, p.target_end_date,
                COALESCE(a.actual_cost,0) AS actual_cost,
                COALESCE(t.tasks,0)::int AS tasks, COALESCE(t.done,0)::int AS done_tasks
           FROM construction_projects p
           LEFT JOIN (SELECT project_id, SUM(qty*rate) AS actual_cost FROM inventory_movements
                       WHERE site_id = $1 AND movement_type = 'CONSUMPTION' GROUP BY project_id) a ON a.project_id = p.id
           LEFT JOIN (SELECT project_id, COUNT(*) AS tasks, COUNT(*) FILTER (WHERE status = 'DONE') AS done
                       FROM construction_tasks GROUP BY project_id) t ON t.project_id = p.id
          WHERE p.site_id = $1 ORDER BY (p.status = 'DELAYED') DESC, p.budget DESC LIMIT 20`, [siteId]),
      q(`SELECT t.name, p.name AS project, t.status, t.progress_pct, t.due_date
           FROM construction_tasks t JOIN construction_projects p ON p.id = t.project_id
          WHERE p.site_id = $1 AND t.status <> 'DONE' ORDER BY (t.due_date < CURRENT_DATE) DESC, t.due_date NULLS LAST LIMIT 20`, [siteId]),
      q(`SELECT COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE status IN ('REQUESTED','PARTIALLY_FULFILLED'))::int AS pending
           FROM construction_material_requests WHERE site_id = $1`, [siteId]),
    ]);
    return {
      note: 'Construction actual cost is derived only from inventory CONSUMPTION movements (quantity × rate), not purchases or issues.',
      projects: projects.map((p) => ({
        name: cleanText(p.name, 70), code: cleanText(p.code, 30), status: p.status, progress_pct: num(p.progress_pct),
        budget: r0(p.budget), actual_cost: r0(p.actual_cost), tasks: p.tasks, done_tasks: p.done_tasks,
        target_end_date: p.target_end_date ? new Date(p.target_end_date).toISOString().slice(0, 10) : null,
      })),
      open_tasks: tasks.map((t) => ({ project: cleanText(t.project, 60), task: cleanText(t.name, 70), status: t.status, progress_pct: num(t.progress_pct), due_date: t.due_date ? new Date(t.due_date).toISOString().slice(0, 10) : null })),
      material_requests: requests[0] || { total: 0, pending: 0 },
    };
  },
  timing: async (siteId, { from, to }) => {
    const P = [siteId, from, to];
    const W = `site_id = $1 AND financial_transaction_posts('credit', status, payment_type, cheque_status)
               AND amount > 0 AND date >= $2::date AND date <= LEAST($3::date, CURRENT_DATE)`;
    const [dom, dow, mon, tot] = await Promise.all([
      q(`SELECT EXTRACT(DAY FROM date)::int AS day, COUNT(*)::int AS count, SUM(amount) AS amount FROM plot_payments WHERE ${W} GROUP BY 1 ORDER BY 1`, P),
      q(`SELECT EXTRACT(ISODOW FROM date)::int AS dow, COUNT(*)::int AS count, SUM(amount) AS amount FROM plot_payments WHERE ${W} GROUP BY 1 ORDER BY 1`, P),
      q(`SELECT to_char(date_trunc('month', date), 'YYYY-MM') AS month, COUNT(*)::int AS count, SUM(amount) AS amount FROM plot_payments WHERE ${W} GROUP BY 1 ORDER BY 1 DESC LIMIT 12`, P),
      q(`SELECT COUNT(*)::int AS count, COALESCE(SUM(amount),0) AS amount, MIN(date) AS first, MAX(date) AS last FROM plot_payments WHERE ${W}`, P),
    ]);
    const total = tot[0] || { count: 0, amount: 0 };
    const byDay = dom.map((r) => ({ day: r.day, receipts: r.count, amount: r0(r.amount), share_of_receipts_pct: total.count ? Math.round((r.count / total.count) * 1000) / 10 : 0 }));
    const names = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    const byWeekday = dow.map((r) => ({ weekday: names[r.dow], receipts: r.count, amount: r0(r.amount), share_of_receipts_pct: total.count ? Math.round((r.count / total.count) * 1000) / 10 : 0 }));
    const top = (arr, k) => [...arr].sort((a, b) => b[k] - a[k]).slice(0, 5);
    return {
      note: `Plot receipts between ${from} and ${to}: pending and approved credits, with cheques included only after clearance. "Probability" here = historical share of receipts; the busiest calendar days and weekdays are the most likely collection days.`,
      receipts: total.count, amount: r0(total.amount), first: total.first ? new Date(total.first).toISOString().slice(0, 10) : null, last: total.last ? new Date(total.last).toISOString().slice(0, 10) : null,
      best_days_by_count: top(byDay, 'receipts'), best_days_by_amount: top(byDay, 'amount'),
      best_weekdays: top(byWeekday, 'receipts'),
      by_day_of_month: byDay, by_weekday: byWeekday,
      recent_months: mon.map((r) => ({ month: r.month, receipts: r.count, amount: r0(r.amount) })),
    };
  },
  approvals: async (siteId) => {
    const [pp, ex, cq] = await Promise.all([
      q(`SELECT p.plot_no, pp.buyer_name, pp.amount, pp.date FROM plot_payments pp JOIN plots p ON p.id = pp.plot_id
          WHERE pp.site_id = $1 AND pp.status = 'pending' ORDER BY pp.date LIMIT 8`, [siteId]),
      q(`SELECT to_entity, category, debit AS amount, date FROM expenses WHERE site_id = $1 AND status = 'pending' ORDER BY date LIMIT 8`, [siteId]),
      q(`SELECT 'plot_payment' AS kind, COUNT(*)::int AS count, COALESCE(SUM(amount),0) AS amount FROM plot_payments WHERE site_id = $1 AND cheque_status = 'PENDING'
         UNION ALL SELECT 'expense', COUNT(*)::int, COALESCE(SUM(debit),0) FROM expenses WHERE site_id = $1 AND cheque_status = 'PENDING'`, [siteId]),
    ]);
    return {
      pending_plot_payments: pp.map((r) => ({ plot_no: r.plot_no, buyer: cleanText(r.buyer_name, 50), amount: r0(r.amount), date: new Date(r.date).toISOString().slice(0, 10) })),
      pending_expenses: ex.map((r) => ({ payee: cleanText(r.to_entity, 50), category: cleanText(r.category, 40), amount: r0(r.amount), date: new Date(r.date).toISOString().slice(0, 10) })),
      cheques_pending: cq.map((r) => ({ kind: r.kind, count: r.count, amount: r0(r.amount) })),
    };
  },
};

/** Fetch focused slices for the detected topics. `plots` needs nothing extra (already in the snapshot). */
export const buildFocus = async (siteId, range, topics) => {
  const focus = {};
  for (const t of topics) {
    if (!FOCUS_SQL[t]) continue;
    try { focus[t] = await FOCUS_SQL[t](siteId, range); } catch (error) { focus[t] = { error: `unavailable: ${error.message}` }; }
  }
  return focus;
};

const inr = (v) => {
  const n = Math.abs(num(v));
  const sign = num(v) < 0 ? '-' : '';
  if (n >= 1e7) return `${sign}₹${(n / 1e7).toFixed(2)} crore`;
  if (n >= 1e5) return `${sign}₹${(n / 1e5).toFixed(2)} lakh`;
  return `${sign}₹${Math.round(n).toLocaleString('en-IN')}`;
};

/** Deterministic answer for the detected topic (used when the model is unavailable). */
export const localAnswer = (topic, focus, snapshot) => {
  const f = focus?.[topic];
  if (!f || f.error) return null;
  const lines = [];
  if (topic === 'farmers') {
    const open = f.farmers.filter((r) => r.outstanding > 0);
    lines.push(`Farmers: ${f.count} on ${snapshot.site}; agreed land value ${inr(f.liability_total)}, paid ${inr(f.paid_total)}, still to pay ${inr(f.outstanding_total)} (${open.length} farmers pending, ${f.fully_paid} fully paid).`);
    open.slice(0, 6).forEach((r) => lines.push(`- ${r.name}: outstanding ${inr(r.outstanding)} (paid ${inr(r.paid)} of ${inr(r.liability)}${r.last_payment ? `, last payment ${r.last_payment}` : ', no payment yet'})`));
    lines.push('Action: clear the largest farmer balances first — land-seller dues affect registry timelines.');
  } else if (topic === 'vendors') {
    const open = f.commitments.filter((c) => c.status === 'open');
    const out = open.reduce((s, c) => s + c.outstanding, 0);
    lines.push(`Vendors: ${open.length} open commitments, ${inr(out)} outstanding against contracts.`);
    open.slice(0, 6).forEach((c) => lines.push(`- ${c.vendor} — ${c.work}: ${inr(c.outstanding)} pending of ${inr(c.contract)}${c.due_date ? `, due ${c.due_date}` : ''}`));
    lines.push('Action: review overdue commitments before releasing further vendor payments.');
  } else if (topic === 'commissions') {
    const pend = f.agents.filter((a) => a.pending > 0);
    lines.push(`Commissions: ${f.agents.length} agents; pending payouts ${inr(pend.reduce((s, a) => s + a.pending, 0))} across ${pend.length} agents.`);
    pend.slice(0, 6).forEach((a) => lines.push(`- ${a.agent}: pending ${inr(a.pending)} (paid ${inr(a.paid)} of ${inr(a.decided)} on ${a.plots} plots)`));
    lines.push('Action: settle agents whose plots are fully collected first.');
  } else if (topic === 'expenses') {
    lines.push(`Expenses in the period: ${inr(snapshot.expenses?.total)} across ${snapshot.expenses?.count ?? 0} entries; last 30 days ${inr(f.last_30_days)}.`);
    f.by_category.slice(0, 5).forEach((c) => lines.push(`- ${c.category}: ${inr(c.amount)} (${c.count} entries)`));
    if (f.top_payees[0]) lines.push(`- Largest payee: ${f.top_payees[0].payee} ${inr(f.top_payees[0].amount)}`);
    lines.push('Action: review the top category for avoidable spend.');
  } else if (topic === 'imprest') {
    lines.push(`Imprest: ${f.holders.length} holders with a float; total ${inr(f.holders.reduce((s, h) => s + h.balance, 0))}.`);
    f.holders.slice(0, 6).forEach((h) => lines.push(`- ${h.holder}: ${inr(h.balance)} (as of ${h.as_of})`));
    lines.push('Action: ask holders with large balances to submit expense proofs.');
  } else if (topic === 'registries') {
    lines.push(`Registries: ${f.count} on record, ${f.noc_generated} with NOC generated, ${f.noc_pending.length} recent ones without NOC.`);
    f.noc_pending.slice(0, 6).forEach((r) => lines.push(`- Plot ${r.plot_no} (${r.customer})${r.registry_date ? ` registered ${r.registry_date}` : ''}: NOC pending`));
    lines.push('Action: issue NOCs for fully paid plots to avoid registry delays.');
  } else if (topic === 'construction') {
    const delayed = f.projects.filter((p) => p.status === 'DELAYED');
    const budget = f.projects.reduce((sum, p) => sum + p.budget, 0);
    const actual = f.projects.reduce((sum, p) => sum + p.actual_cost, 0);
    lines.push(`Construction: ${f.projects.length} projects with ${inr(budget)} budget and ${inr(actual)} recorded material consumption; ${delayed.length} projects are delayed.`);
    f.projects.slice(0, 6).forEach((p) => lines.push(`- ${p.name}: ${p.progress_pct}% complete, ${inr(p.actual_cost)} actual cost against ${inr(p.budget)} budget (${p.done_tasks}/${p.tasks} tasks done)`));
    if (f.material_requests.pending > 0) lines.push(`- ${f.material_requests.pending} material requests are still pending.`);
    lines.push('Action: review delayed projects and overdue open tasks before releasing more material.');
  } else if (topic === 'timing') {
    const nth = (d) => `${d}${[1, 21, 31].includes(d) ? 'st' : [2, 22].includes(d) ? 'nd' : [3, 23].includes(d) ? 'rd' : 'th'}`;
    lines.push(`Based on ${f.receipts.toLocaleString('en-IN')} approved plot receipts (${inr(f.amount)}) on ${snapshot.site}, the days money most often comes in:`);
    f.best_days_by_count.forEach((d, i) => lines.push(`${i + 1}. ${nth(d.day)} of the month — ${d.receipts} receipts (${d.share_of_receipts_pct}% of all), ${inr(d.amount)}`));
    if (f.best_weekdays[0]) lines.push(`- Busiest weekday: ${f.best_weekdays.map((w) => `${w.weekday} ${w.share_of_receipts_pct}%`).join(', ')}.`);
    if (f.best_days_by_amount[0]) lines.push(`- By amount the biggest day is the ${nth(f.best_days_by_amount[0].day)} (${inr(f.best_days_by_amount[0].amount)}).`);
    lines.push('Action: schedule collection calls and reminders 2 days before these dates.');
  } else if (topic === 'approvals') {
    const a = snapshot.approvals || {};
    lines.push(`Pending approvals: ${a.pending_plot_payments ?? 0} plot payments, ${a.pending_expenses ?? 0} expenses, ${a.pending_commission_payments ?? 0} commission payouts; ${a.pending_cheques ?? 0} cheques awaiting clearance.`);
    f.pending_plot_payments.slice(0, 4).forEach((r) => lines.push(`- Plot ${r.plot_no} (${r.buyer}) ${inr(r.amount)} dated ${r.date}`));
    f.cheques_pending.forEach((c) => lines.push(`- Pending cheques (${c.kind}): ${c.count} worth ${inr(c.amount)}`));
    lines.push('Action: clear the oldest pending entries so the ledger reflects money already received.');
  }
  return lines.length ? lines.join('\n') : null;
};

export const TOPIC_LABELS = {
  farmers: 'FARMERS (land sellers the company pays)', vendors: 'VENDORS / CONTRACTORS', commissions: 'AGENT COMMISSIONS', timing: 'PAYMENT TIMING (which days / weekdays money comes in)',
  expenses: 'EXPENSES', imprest: 'IMPREST (petty cash)', registries: 'REGISTRIES / NOC', construction: 'CONSTRUCTION PROJECTS', approvals: 'PENDING APPROVALS & CHEQUES',
  plots: 'PLOTS / BUYERS / COLLECTIONS',
};
