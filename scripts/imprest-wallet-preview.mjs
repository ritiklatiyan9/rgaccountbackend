// Run the updated local API without production schedulers or replaying older
// financial migrations. The current wallet schema must already be installed.
import http from 'node:http';
import app from '../src/app.js';
import pool from '../src/config/db.js';
import { up } from '../src/migrations/213_wallet_funded_imprest.js';
import { initSocket } from '../src/config/socket.js';
import { initCache } from '../src/config/cache.js';

const { rows } = await pool.query("SELECT version FROM app_schema_migrations WHERE version='212_wallet_permanent_balance_guard'");
if (!rows.length) throw new Error('Apply the current Cash Wallet migrations through 212 before starting this preview.');
await up(pool);
const server = http.createServer(app);
initSocket(server);
initCache();
const port = Number(process.env.LOCAL_API_PORT || 8000);
server.listen(port, '127.0.0.1', () => console.log(`Imprest and wallet API ready on http://127.0.0.1:${port}`));
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    server.close(() => pool.end().finally(() => process.exit(0)));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
