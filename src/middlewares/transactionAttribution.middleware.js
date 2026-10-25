import { withTransactionAttribution } from '../services/transactionAttribution.service.js';

// Read responses only. Authentication and each module's existing row/site
// authorization run before res.json; writes and approval decisions are untouched.
const financialPath = /^\/(?:farmers|land-deals|misc-income|tds|commissions|plot-commission|cashflow|firms|plots|expenses|registries|daybook|banks|imprest|document-imprest|approvals|vendors|balance-sheet|construction|reports|module-reports|members|sites|wallet|loyalty-vault)(?:\/|$)/;
export function transactionAttributionMiddleware(req, res, next) {
  if (req.method !== 'GET' || !financialPath.test(req.path)) return next();
  const json = res.json.bind(res);
  let responding = false;
  res.json = function (payload) {
    if (responding || res.statusCode >= 400 || !req.user?.id) return json(payload);
    responding = true;
    void withTransactionAttribution(payload, req.authenticatedUser || req.user)
      .then(enriched => json(enriched)).catch(next);
    return res;
  };
  next();
}
