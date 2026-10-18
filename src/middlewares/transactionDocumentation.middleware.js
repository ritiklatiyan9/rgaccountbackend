import pool, { connectOutsideRequestTransaction } from '../config/db.js';
import { createRequestTransaction, requestTransactionContext } from '../services/requestTransactionContext.js';
import { documentationSource, documentationSourceForTable, DOCUMENTATION_TARGETS, validateDocumentationDraft, saveDocumentation, documentationError } from '../services/transactionDocumentation.service.js';
import { clearCacheByPrefixes } from '../config/cache.js';

// Only native financial writes may open this opt-in transaction boundary.
// In particular, approvals can dispatch notifications and must never consume
// a stale modal header intended for an ordinary create/edit operation.
const DOCUMENTATION_WRITE_PATHS = [/^\/expenses(?:\/\d+)?$/, /^\/imprest\/expense$/, /^\/farmers\/\d+\/payments(?:\/\d+)?$/, /^\/cashflow\/entries(?:\/\d+)?$/, /^\/firms\/transactions(?:\/\d+|\/firm-to-firm)?$/, /^\/plots\/payments(?:\/\d+)?$/, /^\/plots\/\d+\/installment-payment$/, /^\/(?:plots\/\d+\/)?installments\/\d+\/payments(?:\/\d+)?$/, /^\/registries\/payments(?:\/\d+)?$/, /^\/commissions(?:\/\d+)?$/, /^\/plot-commission\/payment(?:\/\d+)?$/, /^\/land-deals\/\d+\/payments(?:\/\d+)?$/, /^\/misc-income(?:\/\d+)?$/, /^\/sites\/\d+\/profit-payments(?:\/\d+)?$/, /^\/vendors\/commitments\/\d+\/payments(?:\/\d+)?$/, /^\/vendors\/payments\/\d+$/, /^\/vendors\/inventory\/\d+\/payments(?:\/\d+)?$/, /^\/vendors\/inventory\/(?:payments|inv-payments)\/\d+$/, /^\/daybook(?:\/\d+)?$/, /^\/daybook\/(?:expense|farmer-payment|commission|cashflow-entry|firm-transaction|plot-payment)\/\d+$/, /^\/daybook\/module-entry\/[a-z_]+\/\d+$/];
export const createTransactionDocumentationMiddleware = ({
  database = pool,
  connect = connectOutsideRequestTransaction
} = {}) => (req, res, next) => {
  if (!['POST', 'PUT', 'PATCH'].includes(req.method) || req.path.startsWith('/transaction-documentation')) return next();
  const header = req.get?.('X-Transaction-Documentation');
  const supplied = header !== undefined || req.body?.documentation !== undefined;
  if (!supplied) return next();
  let draft;
  try {
    draft = validateDocumentationDraft(header !== undefined ? JSON.parse(header) : req.body.documentation);
    draft.source = documentationSource(draft.source);
    if (!DOCUMENTATION_TARGETS[draft.source]) throw documentationError('Choose the source module for documentation settings.');
  } catch (error) {
    return res.status(400).json({
      message: error.message || 'Invalid documentation settings.'
    });
  }
  // Review requests store their draft with the proposed change, rather than
  // changing the source before the financial edit is approved.
  if (req.path.startsWith('/edit-requests')) {
    // Multer parses multipart proposed_data later at the route boundary.
    req.transactionDocumentationDraft = draft;
    return next();
  }
  if (!DOCUMENTATION_WRITE_PATHS.some(pattern => pattern.test(req.path.replace(/\/$/, '')))) {
    return res.status(400).json({
      message: 'Documentation settings must be saved with a native financial transaction.'
    });
  }
  let financialWrite,
    finishing = false;
  const transaction = createRequestTransaction({
    connect,
    onWrite: write => {
      if (documentationSourceForTable(write.table) !== draft.source) return;
      const rows = write.rows.filter(row => !(row.is_firm_to_firm_transfer && row.transfer_direction === 'IN'));
      if (!rows.length) return;
      if (rows.length !== 1 || !rows[0].id) throw documentationError('Documentation settings apply to one transaction at a time.');
      const id = Number(rows[0].id);
      if (financialWrite && financialWrite.id !== id) throw documentationError('Choose a single source transaction for documentation settings.');
      financialWrite = {
        id,
        creation: financialWrite?.creation || write.creation
      };
    }
  });
  const originalJson = res.json.bind(res);
  // Response completion schedules HTTP audit/cleanup work. Those callbacks
  // must run outside the now committed request transaction.
  const respond = payload => requestTransactionContext.run(null, () => originalJson(payload));
  res.json = function (payload) {
    if (finishing) return res;
    finishing = true;
    void (async () => {
      try {
        if (res.statusCode >= 400) {
          await transaction.finish(false);
          return respond(payload);
        }
        if (!financialWrite) throw documentationError('No matching financial transaction was saved.');
        const documentation = await saveDocumentation(req.user, draft.source, financialWrite.id, draft, database, {
          creation: financialWrite.creation
        });
        await transaction.finish(true);
        await clearCacheByPrefixes(['approvals|', 'expenses|', 'expenses:page:', 'expenses:breakdown:']).catch(() => {});
        return respond({
          ...payload,
          documentation
        });
      } catch (error) {
        await transaction.finish(false).catch(() => {});
        res.status(error.statusCode || 500);
        return respond({
          message: error.statusCode ? error.message : 'The transaction and documentation could not be saved. Please retry.',
          code: error.code || 'DOCUMENTATION_SAVE_FAILED'
        });
      }
    })();
    return res;
  };
  res.once('close', () => {
    if (!finishing) void transaction.finish(false).catch(() => {});
  });
  return requestTransactionContext.run(transaction, next);
};
export const transactionDocumentationMiddleware = createTransactionDocumentationMiddleware();
