// Local API for frontend development. Schedulers run only in src/server.js.
import http from 'node:http';
import app from '../src/app.js';
import { initSocket } from '../src/config/socket.js';
import { initCache } from '../src/config/cache.js';
import { backupMaintenanceEnabled } from '../src/middlewares/backupMaintenance.middleware.js';
import pool from '../src/config/db.js';
import { up as migrateMemberSiteSharing } from '../src/migrations/187_member_site_sharing.js';
await migrateMemberSiteSharing(pool);
const server = http.createServer(app);
if (!backupMaintenanceEnabled()) initSocket(server);
initCache();
const port = Number(process.env.LOCAL_API_PORT || 3000);
server.listen(port, '127.0.0.1', () => console.log(`Local development API ready on http://127.0.0.1:${port}`));
for (const signal of ['SIGTERM','SIGINT']) process.once(signal, () => server.close(() => process.exit(0)));
