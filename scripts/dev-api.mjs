// Local API for frontend development. Schedulers run only in src/server.js.
import http from 'node:http';
import app from '../src/app.js';
import { initSocket } from '../src/config/socket.js';
import { initCache } from '../src/config/cache.js';
const server = http.createServer(app);
initSocket(server); initCache();
server.listen(Number(process.env.LOCAL_API_PORT || 3000), '127.0.0.1', () => console.log('Local development API ready on http://127.0.0.1:3000'));
for (const signal of ['SIGTERM','SIGINT']) process.once(signal, () => server.close(() => process.exit(0)));
