// Local application preview using the configured database and authentication.
// Run schema migrations explicitly with npm run migrate when needed.
import http from 'node:http';
import app from '../src/app.js';
import { up as migratePlotAreaChanges } from '../src/migrations/205_plot_area_conversion_and_approval_changes.js';
import { up as migratePlotBankRounding } from '../src/migrations/206_plot_bank_target_rounding.js';
import { up as migrateChequeTransactionDates } from '../src/migrations/215_cheque_transaction_dates.js';
import { up as migrateCashWalletSiteScope } from '../src/migrations/208_cash_wallet_site_scope.js';
import { up as migrateCashWalletReceiptDetails } from '../src/migrations/209_cash_wallet_receipt_details.js';
import { up as migrateWalletBalanceGuards } from '../src/migrations/210_wallet_balance_guards.js';
import { up as migrateLockedCashCollector } from '../src/migrations/211_locked_cash_collector.js';
import { up as migratePermanentWalletGuard } from '../src/migrations/212_wallet_permanent_balance_guard.js';
import pool from '../src/config/db.js';
import { initSocket } from '../src/config/socket.js';
import { initCache } from '../src/config/cache.js';
import { backupMaintenanceEnabled } from '../src/middlewares/backupMaintenance.middleware.js';

await migratePlotAreaChanges(pool);
await migratePlotBankRounding(pool);
await migrateChequeTransactionDates(pool);
await migrateCashWalletSiteScope(pool);
await migrateCashWalletReceiptDetails(pool);
await migrateWalletBalanceGuards(pool);
await migrateLockedCashCollector(pool);
await migratePermanentWalletGuard(pool);
const server = http.createServer(app);
if (!backupMaintenanceEnabled()) initSocket(server);
initCache();
const port = Number(process.env.LOCAL_API_PORT || 8000);
server.listen(port, '127.0.0.1', () => console.log(`Local API ready on http://127.0.0.1:${port}`));

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    server.close(() => pool.end().finally(() => process.exit(0)));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
