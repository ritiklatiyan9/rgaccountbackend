import 'dotenv/config';
import http from 'node:http';
import app from './app.js';
import pool, { connectDB } from './config/db.js';
import { initSocket } from './config/socket.js';
import { initCache } from './config/cache.js';

// Local previews serve the application without starting production reminder
// schedulers. They use the same authentication, permissions and database.
const port = Number(process.env.LOCAL_API_PORT || 3001);
const server = http.createServer(app);
initSocket(server);
initCache();
connectDB().then(() => server.listen(port, '127.0.0.1', () => {
  console.log(`Local API ready at http://127.0.0.1:${port}`);
})).catch((error) => { console.error(error.message); process.exit(1); });
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    server.close(() => pool.end().finally(() => process.exit(0)));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
