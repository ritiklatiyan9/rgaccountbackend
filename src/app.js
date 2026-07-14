import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import { createHandler } from 'graphql-http/lib/use/express';
import { schema as graphqlSchema } from './graphql/schema.js';
import { verifyToken } from './config/jwt.js';
import errorMiddleware from './middlewares/error.middleware.js';

const app = express();

app.use(helmet());
app.use(morgan('combined'));
app.use(cors());
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));

import path from 'path';
// Serve fallback local excel files if AWS S3 isn't configured
app.use('/uploads/excel', express.static(path.join(process.cwd(), 'uploads', 'excel')));
// Serve fallback local plot/KYC documents if AWS S3 isn't configured (dev only)
app.use('/uploads/kyc_documents', express.static(path.join(process.cwd(), 'uploads', 'kyc_documents')));

// ── GraphQL endpoint (dashboard BFF) ──
app.all('/graphql', createHandler({
  schema: graphqlSchema,
  context: (req) => {
    // Extract JWT from Authorization header for GraphQL context
    const token = req.raw.headers.authorization?.replace('Bearer ', '');
    let user = null;
    if (token) {
      try { user = verifyToken(token); } catch { /* unauthenticated */ }
    }
    return { user };
  },
}));

// routes
import indexRoutes from './routes/index.js';
app.use('/', indexRoutes);

// error middleware
app.use(errorMiddleware);

// ── Keep-alive: ping backends every 12 minutes so they don't sleep ──
const KEEP_ALIVE_URLS = [
  'https://sales-backend-ponq.onrender.com',
  'https://cropland-crm-backend.onrender.com',
  'https://diwan-city-backend.onrender.com',
];
const KEEP_ALIVE_INTERVAL_MS = 12 * 60 * 1000;

setInterval(async () => {
  for (const url of KEEP_ALIVE_URLS) {
    try {
      const res = await fetch(url, { method: 'GET' });
      console.log(`[keep-alive] pinged ${url} -> ${res.status}`);
    } catch (err) {
      console.error(`[keep-alive] ping failed for ${url}: ${err.message}`);
    }
  }
}, KEEP_ALIVE_INTERVAL_MS);

export default app;