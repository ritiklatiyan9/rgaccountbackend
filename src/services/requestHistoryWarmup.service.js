import { warmRequestHistorySchema } from './requestHistory.service.js';
import { hasRelations } from '../utils/schemaProbe.js';

// Warm schema only, before accepting traffic. No user grants, session proofs or
// financial responses are cached by this startup work.
export async function warmRequestHistory(database) {
  await Promise.all([
    warmRequestHistorySchema(database),
    hasRelations(['transaction_transfer_approval_requests', 'plot_status_approvals', 'transaction_documentation',
      'transaction_party_links', 'edit_requests', 'seek_permissions', 'loyalty_vault_transfers', 'wallet_imprest_transfers',
      'imprest_expense_requests', 'imprest_returns', 'imprest_allocations']),
  ]);
}
