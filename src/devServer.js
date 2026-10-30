import 'dotenv/config';
import http from 'node:http';
import app from './app.js';
import { up as migrateTransactionDocumentation } from './migrations/218_transaction_documentation.js';
import { up as migratePlotAreaChanges } from './migrations/205_plot_area_conversion_and_approval_changes.js';
import { up as migratePlotBankRounding } from './migrations/206_plot_bank_target_rounding.js';
import pool, { connectDB } from './config/db.js';
import { initSocket } from './config/socket.js';
import { initCache } from './config/cache.js';
import { backupMaintenanceEnabled } from './middlewares/backupMaintenance.middleware.js';
import { up as migrateTdsDeducteeMapping } from './migrations/191_tds_deductee_mapping.js';
import { up as migrateDataStorage } from './migrations/193_data_storage.js';
import { up as migrateDataStorageSubAdminAccess } from './migrations/227_data_storage_sub_admin_access.js';
import { up as migrateMemberSiteSharing } from './migrations/187_member_site_sharing.js';
import { up as migrateMemberIdentityLinking } from './migrations/192_member_identity_linking.js';
import { up as migrateTdsFinancialSettlements } from './migrations/198_tds_financial_settlements.js';
import { up as migrateImprestApprovalIndexes } from './migrations/197_imprest_approval_activity_indexes.js';
import { up as migrateImprestCashGuard } from './migrations/195_imprest_cash_funding_guard.js';
import { up as migrateExistingVoucherGaps } from './migrations/196_existing_voucher_gaps_filled.js';
import { up as migratePlotFullPaymentDue } from './migrations/201_plot_full_payment_due.js';
import { up as migrateLoyaltyVault } from './migrations/199_loyalty_vault.js';
import { up as migrateUnifiedCashWallet } from './migrations/203_unified_cash_wallet.js';
import { up as migrateCashWalletReadIndexes } from './migrations/204_cash_wallet_read_indexes.js';
import { up as migrateCreditWalletImprestDebits } from './migrations/207_credit_wallet_imprest_debits.js';
import { up as migrateCashWalletSiteScope } from './migrations/208_cash_wallet_site_scope.js';

// Local previews serve the application without starting production reminder
// schedulers. They use the same authentication, permissions and database.
const port = Number(process.env.LOCAL_API_PORT || 3001);
const server = http.createServer(app);
if (!backupMaintenanceEnabled()) initSocket(server);
initCache();
connectDB().then(async () => {
  await migratePlotAreaChanges(pool);
  await migratePlotBankRounding(pool);
  await migrateMemberSiteSharing(pool);
  await migrateMemberIdentityLinking(pool);
  await migrateTdsDeducteeMapping(pool);
  await migrateTdsFinancialSettlements(pool);
  await migrateDataStorage(pool);
  await migrateDataStorageSubAdminAccess(pool);
  await migrateImprestCashGuard(pool);
  await migrateImprestApprovalIndexes(pool);
  await migrateExistingVoucherGaps(pool);
  await migratePlotFullPaymentDue(pool);
  await migrateLoyaltyVault(pool);
  await migrateUnifiedCashWallet(pool);
  await migrateCashWalletReadIndexes(pool);
  await migrateCreditWalletImprestDebits(pool);
  await migrateCashWalletSiteScope(pool);
  await migrateTransactionDocumentation(pool);
  server.listen(port, '127.0.0.1', () => {
    console.log(`Local API ready at http://127.0.0.1:${port}`);
  });
}).catch((error) => { console.error(error.message); process.exit(1); });
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    server.close(() => pool.end().finally(() => process.exit(0)));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
