import 'dotenv/config';

import app from './app.js';
import { connectDB } from './config/db.js';
import migrateAddCashType from './migrations/001_add_cash_type.js';

const PORT = process.env.PORT || 3000;

connectDB().then(async () => {
  // Run migrations
  await migrateAddCashType();
  
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
}).catch(err => {
  console.error('Failed to connect to DB', err);
  process.exit(1);
});