// Preview the current history reader against the configured database without
// migrations, schedulers or financial writes. Other modules use their normal API.
import express from 'express';
import cors from 'cors';
import pool from '../src/config/db.js';
import auth from '../src/middlewares/auth.middleware.js';
import { history, historyDetail, transfers } from '../src/controllers/loyaltyVault.controller.js';

const app = express();
app.use(cors({ origin: ['http://127.0.0.1:5174', 'http://localhost:5174'], credentials: true }));
app.get('/wallet/history', auth, history);
app.get('/wallet/history/:id', auth, historyDetail);
app.get('/wallet/transfers', auth, transfers);
app.use((error, _req, res, _next) => {
  console.error('Wallet history preview:', error.message);
  res.status(error.statusCode || 500).json({ message: error.statusCode ? error.message : 'Unable to load wallet history.' });
});
const port = Number(process.env.WALLET_HISTORY_PREVIEW_PORT || 8001);
const server = app.listen(port, '127.0.0.1', () => console.log(`Wallet history preview ready on http://127.0.0.1:${port}`));
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  server.close(() => pool.end().finally(() => process.exit(0)));
});
