import pool from '../config/db.js';
import { accountWhatsAppHooks } from './accountWhatsAppHooks.service.js';
import { createRequestTransaction, requestTransactionContext } from './requestTransactionContext.js';
import { assertAllocationSite, calculateCommissionAllocations, commissionAllocationRevision, positiveId, replaceCommissionAllocations } from './commissionAllocations.service.js';

const fail = (message, statusCode = 400, code = 'INVALID_BOOKING_ALLOCATIONS') => {
  throw Object.assign(new Error(message), { statusCode, code });
};

// Opt in only for a structured Booking By split. All queries made by the plot
// controller (including its nested model transactions) share one transaction.
// Do not acknowledge the property until its commission records also commit.
export function withPlotBookingAllocations(handler, { database = pool } = {}) {
  return async (req, res, next) => {
    if (!Object.hasOwn(req.body || {}, 'booking_allocations')) return handler(req, res, next);
    const draft = req.body.booking_allocations;
    if (!draft || typeof draft !== 'object' || Array.isArray(draft)) fail('Booking dealer allocations must be an object');
    const plan = calculateCommissionAllocations(draft.total_commission, draft.allocations);
    if (!plan.allocations.length && req.params?.id === undefined) fail('Select at least one booking dealer');
    const inheritedTransaction = requestTransactionContext.getStore();
    const transaction = inheritedTransaction || createRequestTransaction({ connect: () => requestTransactionContext.run(null, () => database.connect()) });
    const originalJson = res.json;
    let response, previousPlot;
    res.json = function (payload) { response = { payload, status: res.statusCode || 200 }; return res; };
    try {
      await requestTransactionContext.run(transaction, async () => {
        const updating = req.params?.id !== undefined;
        let before;
        if (updating) {
          const id = positiveId(req.params.id);
          before = (await database.query('SELECT * FROM plots WHERE id=$1 FOR UPDATE', [id])).rows[0];
          if (!before) fail('Plot or shop not found', 404);
          previousPlot = before;
          const masters = (await database.query('SELECT * FROM plot_commissions_v2 WHERE plot_id=$1 ORDER BY id FOR UPDATE', [id])).rows;
          if (draft.revision !== commissionAllocationRevision(before, masters)) {
            fail('The booking dealer breakdown changed. Reload it before saving.', 409, 'COMMISSION_ALLOCATION_CONFLICT');
          }
          if (req.body.site_id != null && Number(req.body.site_id) !== Number(before.site_id)) fail('A property cannot be moved to a different site');
        }
        const siteId = positiveId(before?.site_id ?? req.body.site_id);
        await assertAllocationSite(database, req.user, siteId);
        const ids = plan.allocations.map(row => row.agent_id);
        const { rows: members } = await database.query(`SELECT m.id,m.full_name FROM members m JOIN sites s ON s.id=m.site_id
          WHERE m.id=ANY($1::int[]) AND s.organization_id=$2`, [ids, req.user.organization_id]);
        if (members.length !== ids.length) fail('A selected booking dealer is unavailable in this organization');
        const names = new Map(members.map(member => [Number(member.id), member.full_name]));
        req.body.booking_by = ids.length ? ids.map(id => String(names.get(id) || '').trim().toUpperCase()).join(', ') : null;
        req.body.plot_commission = plan.total_commission;
        req.body.commission_enabled = true;
        const area = Number(req.body.plot_size ?? before?.plot_size);
        const poolChanged = !before || Number(before.plot_commission || 0) !== plan.total_commission;
        const areaChanged = !before || Number(before.plot_size || 0) !== area;
        if (poolChanged || areaChanged) req.body.commission_rate = area > 0 ? Number((plan.total_commission / area).toFixed(6)) : 0;
        await handler(req, res, next);
        if (!response) throw new Error('Booking update did not produce a response');
        if (response.status >= 400) return;
        const plot = response.payload.plot;
        if (!plot?.id) throw new Error('Booking update did not return the saved property');
        // The client revision was checked against the locked original above.
        // The plot update may itself change the pool, so derive the replacement
        // revision from this transaction's new property snapshot.
        const current = (await database.query('SELECT * FROM plots WHERE id=$1 FOR UPDATE', [plot.id])).rows[0];
        const masters = (await database.query('SELECT * FROM plot_commissions_v2 WHERE plot_id=$1 ORDER BY id FOR UPDATE', [plot.id])).rows;
        const saved = await replaceCommissionAllocations(database, req.user, {
          site_id: siteId, plot_id: plot.id, total_commission: plan.total_commission,
          allocations: draft.allocations, revision: commissionAllocationRevision(current, masters),
        });
        response.payload = { ...response.payload, booking_allocations: saved };
      });
      if (!inheritedTransaction) await transaction.finish(response.status < 400);
      if (response.status < 400 && !inheritedTransaction) {
        try { await requestTransactionContext.run(null, () => accountWhatsAppHooks.plotBooked(response.payload.plot, previousPlot)); }
        catch (error) { console.error('[booking-allocations] Could not queue committed booking event:', error.message); }
      }
      res.json = originalJson;
      return requestTransactionContext.run(null, () => res.json(response.payload));
    } catch (error) {
      if (!inheritedTransaction) await transaction.finish(false).catch(() => {});
      throw error;
    } finally { res.json = originalJson; }
  };
}
