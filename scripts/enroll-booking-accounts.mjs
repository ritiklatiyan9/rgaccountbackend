import pool from '../src/config/db.js';
import { poolEnrollmentPlan, enrollExistingPoolReceipts } from '../src/services/poolMoneyEnrollment.service.js';

// Explicit project/actor scope; defaults to a read-only plan. Safe to rerun.
const args = process.argv.slice(2);
const option = flag => args[args.indexOf(flag) + 1];
const siteId = args.includes('--site-id') ? Number(option('--site-id')) : NaN;
const actorId = args.includes('--actor-id') ? Number(option('--actor-id')) : NaN;
try {
  if (![siteId, actorId].every(id => Number.isSafeInteger(id) && id > 0)) throw new Error('Use --site-id <id> --actor-id <id> [--apply --expected-amount <amount> --expected-count <count>]');
  const { rows: [user] } = await pool.query('SELECT id,role,organization_id,is_active FROM users WHERE id=$1', [actorId]);
  let result;
  if (args.includes('--apply')) {
    const expectedAmount = args.includes('--expected-amount') ? Number(option('--expected-amount')) : NaN;
    const expectedCount = args.includes('--expected-count') ? Number(option('--expected-count')) : NaN;
    result = await enrollExistingPoolReceipts(pool, user, siteId, { expectedAmount, expectedCount });
  } else {
    const db = await pool.connect();
    try {
      await db.query('BEGIN READ ONLY');
      result = await poolEnrollmentPlan(db, user, siteId);
      await db.query('ROLLBACK');
    } finally { db.release(); }
  }
  console.log(JSON.stringify(result, null, 2));
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally { await pool.end(); }
