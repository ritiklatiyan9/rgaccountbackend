// Local application preview using the configured database and authentication.
// Run schema migrations explicitly with npm run migrate when needed.
import http from 'node:http';
import app from '../src/app.js';
import pool from '../src/config/db.js';
import { initSocket } from '../src/config/socket.js';
import { initCache } from '../src/config/cache.js';
import { backupMaintenanceEnabled } from '../src/middlewares/backupMaintenance.middleware.js';

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
