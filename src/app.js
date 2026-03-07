import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import errorMiddleware from './middlewares/error.middleware.js';

const app = express();

app.use(helmet());
app.use(morgan('combined'));
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// routes
import indexRoutes from './routes/index.js';
app.use('/', indexRoutes);

// error middleware
app.use(errorMiddleware);

export default app;