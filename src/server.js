import { up as migrateSeekPermissions } from './migrations/222_seek_permissions.js';
import { up as migrateSeekTargets } from './migrations/223_seek_permission_targets.js';
import { up as migrateSeekComments } from './migrations/230_seek_permission_comments.js';
import { up as migrateSeekPriority } from './migrations/231_seek_permission_priority.js';
import { up as migrateImprestVisibility } from './migrations/229_imprest_management_visibility.js';
import { up as migrateBookingAccountsLogin } from './migrations/228_booking_accounts_login_access.js';
import { ensureWalletStartup } from './services/walletStartup.service.js';
import { ensureConstructionStartup } from './services/constructionStartup.service.js';
import 'dotenv/config';
import http from 'http';
import app from './app.js';
import { up as migratePlotAreaChanges } from './migrations/205_plot_area_conversion_and_approval_changes.js';
import { up as migratePlotBankRounding } from './migrations/206_plot_bank_target_rounding.js';
import { up as migratePlotFixedDiscount } from './migrations/214_plot_fixed_discount.js';
import { up as migrateChequeTransactionDates } from './migrations/215_cheque_transaction_dates.js';
import { up as backfillHistoricalChequeDates } from './migrations/216_historical_cheque_entry_dates.js';
import pool, { connectDB } from './config/db.js';
import { up as migrateMemberSiteSharing } from './migrations/187_member_site_sharing.js';
import { up as migrateMemberIdentityLinking } from './migrations/192_member_identity_linking.js';
import { up as migrateMemberIdentityConsolidation } from './migrations/194_member_identity_consolidation.js';
import { up as migrateGoogleDrive } from './migrations/188_google_drive_sharing.js';
import { up as migrateGoogleDriveSiteAccess } from './migrations/189_google_drive_site_access.js';
import { up as migrateGoogleDriveJobs } from './migrations/190_google_drive_share_jobs.js';
import { up as migrateTdsDeducteeMapping } from './migrations/191_tds_deductee_mapping.js';
import { up as migrateDataStorage } from './migrations/193_data_storage.js';
import { up as migrateDataStorageSubAdminAccess } from './migrations/227_data_storage_sub_admin_access.js';
import { up as migrateExistingVoucherGaps } from './migrations/196_existing_voucher_gaps_filled.js';
import { up as migrateTdsFinancialSettlements } from './migrations/198_tds_financial_settlements.js';
import { up as migratePlotFullPaymentDue } from './migrations/201_plot_full_payment_due.js';
import { up as migrateImprestApprovalIndexes } from './migrations/197_imprest_approval_activity_indexes.js';
import { up as migrateTransactionDocumentation } from './migrations/218_transaction_documentation.js';
import { initSocket } from './config/socket.js';
import { initCache } from './config/cache.js';
import { startSmsReminderScheduler } from './services/smsReminder.service.js';
import { startComplianceScheduler, stopComplianceScheduler } from './services/complianceScheduler.service.js';
import { startEventReminderScheduler, stopEventReminderScheduler } from './services/eventReminderScheduler.service.js';
import { backupMaintenanceEnabled } from './middlewares/backupMaintenance.middleware.js';
import { startDriveShareRunner, stopDriveShareRunner } from './services/driveShareJobs.service.js';
import { startAccountWhatsAppWorker, stopAccountWhatsAppWorker } from './services/accountWhatsApp.service.js';
import { startWalletImprestNotificationRunner, stopWalletImprestNotificationRunner } from './services/walletImprestNotifications.service.js';

const PORT = process.env.PORT || 3000;

const server = http.createServer(app);

// Initialize Socket.io attached to the native HTTP server
if (!backupMaintenanceEnabled()) initSocket(server);

initCache();

connectDB().then(async () => {
  await migrateBookingAccountsLogin(pool);
  await migrateImprestVisibility(pool);
  await migrateSeekPermissions(pool);
  await migrateSeekTargets(pool);
  await migrateSeekComments(pool);
  await migrateSeekPriority(pool);
  await migratePlotAreaChanges(pool);
  await migratePlotBankRounding(pool);
  await migratePlotFixedDiscount(pool);
  await migrateChequeTransactionDates(pool);
  await backfillHistoricalChequeDates(pool);
  // Direct node/nodemon starts must have the same required client schema as npm start.
  await migrateMemberSiteSharing(pool);
  await migrateMemberIdentityLinking(pool);
  await migrateMemberIdentityConsolidation(pool);
  await migrateGoogleDrive(pool);
  await migrateGoogleDriveSiteAccess(pool);
  await migrateGoogleDriveJobs(pool);
  await migrateTdsDeducteeMapping(pool);
  await migrateTdsFinancialSettlements(pool);
  const walletStartup = await ensureWalletStartup(pool);
  console.log(walletStartup.applied.length
    ? `[startup] Cash Wallet migrations applied: ${walletStartup.applied.join(', ')}`
    : `[startup] Cash Wallet schema current; installed migrations skipped${walletStartup.repaired.length ? '; runtime functions restored' : ''}`);
  await migratePlotFullPaymentDue(pool);
  await migrateDataStorage(pool);
  await migrateDataStorageSubAdminAccess(pool);
  await migrateExistingVoucherGaps(pool);
  await migrateImprestApprovalIndexes(pool);
  await migrateTransactionDocumentation(pool);
  const constructionStartup = await ensureConstructionStartup(pool);
  console.log(constructionStartup.current
    ? '[startup] Construction schema current; installed migrations skipped'
    : `[startup] Construction migrations applied: ${constructionStartup.applied.join(', ')}`);
  server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
  if (!backupMaintenanceEnabled()) {
    startSmsReminderScheduler();
    startComplianceScheduler();
    startEventReminderScheduler();
    startDriveShareRunner();
    startAccountWhatsAppWorker();
    startWalletImprestNotificationRunner();
  } else console.log('Backup maintenance mode: business APIs, sockets and reminder schedulers are paused.');
}).catch(err => {
  console.error('Backend startup failed', err);
  process.exit(1);
});

const shutdown = (signal) => {
  console.log(`${signal} received — shutting down`);
  stopComplianceScheduler();
  stopEventReminderScheduler();
  stopDriveShareRunner();
  stopAccountWhatsAppWorker();
  void stopWalletImprestNotificationRunner();
  server.close(() => process.exit(0));
  // Fallback if open sockets keep the server from closing promptly.
  setTimeout(() => process.exit(0), 5000).unref();
};
process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));
