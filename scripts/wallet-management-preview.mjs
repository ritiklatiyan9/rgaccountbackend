// Local preview for wallet and access management using configured authentication
// and database. No startup migrations, schedulers or financial repair scripts.
// Frontend .env.development.local: VITE_ACCESS_MANAGEMENT_API_URL=http://127.0.0.1:8002
import express from 'express';
import cors from 'cors';
import pool from '../src/config/db.js';
import auth from '../src/middlewares/auth.middleware.js';
import { getMe } from '../src/controllers/auth.controller.js';
import walletRoutes from '../src/routes/wallet.routes.js';
import settingsRoutes from '../src/routes/applicationSetting.routes.js';
import permissionRoutes from '../src/routes/permission.routes.js';
import auditRequestMiddleware from '../src/middlewares/audit.middleware.js';
import errorMiddleware from '../src/middlewares/error.middleware.js';

const app = express();
app.use(cors({ origin: ['http://127.0.0.1:5174', 'http://localhost:5174'], credentials: true }));
app.use(express.json());
app.use(auditRequestMiddleware);
app.get('/health', (_req, res) => res.json({ service: 'wallet-management-preview', ready: true }));
app.get('/auth/me', auth, getMe);
app.use('/wallet', walletRoutes);
app.use('/loyalty-vault', walletRoutes);
app.use('/settings', settingsRoutes);
app.use('/permissions', permissionRoutes);
app.use(errorMiddleware);
const port = Number(process.env.WALLET_MANAGEMENT_PREVIEW_PORT || 8002);
const server = app.listen(port, '127.0.0.1', () => console.log(`Wallet management preview ready on http://127.0.0.1:${port}`));
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  server.close(() => pool.end().finally(() => process.exit(0)));
});
