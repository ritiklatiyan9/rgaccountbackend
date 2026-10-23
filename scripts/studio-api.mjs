// Local Accountancy preview. Apply schema changes explicitly; starting the API
// must not run production migrations or unrelated reminder schedulers.
import http from 'node:http';
import app from '../src/app.js';
import pool, { connectDB } from '../src/config/db.js';
import { initSocket } from '../src/config/socket.js';
import { initCache } from '../src/config/cache.js';
import { backupMaintenanceEnabled } from '../src/middlewares/backupMaintenance.middleware.js';
import { startAccountWhatsAppWorker, stopAccountWhatsAppWorker } from '../src/services/accountWhatsApp.service.js';

await connectDB();
initCache();
const server = http.createServer(app);
if (!backupMaintenanceEnabled()) {
  initSocket(server);
  startAccountWhatsAppWorker();
}
const port = Number(process.env.LOCAL_API_PORT || 8000);
server.listen(port, '127.0.0.1', () => console.log(`Accountancy preview ready on http://127.0.0.1:${port}`));

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, () => {
    stopAccountWhatsAppWorker();
    server.close(() => pool.end().finally(() => process.exit(0)));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
