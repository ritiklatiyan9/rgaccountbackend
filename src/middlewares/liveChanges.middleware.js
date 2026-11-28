import { clearCacheByPrefixes } from '../config/cache.js';
import { emitToOrganization } from '../config/socket.js';

// Writes under these paths can change what someone's notification screens show.
const AFFECTS_QUEUES = /^\/(approvals|edit-requests|imprest|expenses|farmers|plots|plot-commission|cashflow|firms|daybook|vendors|registries|misc-income|land-deals|transaction-transfers|transaction-documentation|site-transfers|seek-permissions|complaints|wallet|member-kyc)(\/|$)/;
const READ_LIKE = /\/(seen|read|search|preview)(\/|$)/;
const CACHES = ['approvals|', 'edit-requests|', 'imprest|', 'documentation-gaps|'];

/** After a successful write, drop the queue caches and tell the organisation's
 * open tabs to re-read. The ping carries no data: each tab reads again with its
 * own permissions. */
export function createLiveChanges({ emit = emitToOrganization, clear = clearCacheByPrefixes, delayMs = 800 } = {}) {
  const waiting = new Set();
  return (req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method) || !AFFECTS_QUEUES.test(req.path) || READ_LIKE.test(req.path)) return next();
    res.once('finish', () => {
      if (!req.user || res.statusCode >= 400) return;
      const organization = Number(req.user.organization_id) || 1;
      void clear(CACHES).catch(() => {});
      // A burst of writes (bulk approve, quick entry) is one ping.
      if (waiting.has(organization)) return;
      waiting.add(organization);
      setTimeout(() => { waiting.delete(organization); emit(organization, 'data:changed'); }, delayMs).unref?.();
    });
    next();
  };
}
