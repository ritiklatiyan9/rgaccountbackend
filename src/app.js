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
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

import path from 'path';
// Serve fallback local excel files if AWS S3 isn't configured
app.use('/uploads/excel', express.static(path.join(process.cwd(), 'uploads', 'excel')));

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

export default app;