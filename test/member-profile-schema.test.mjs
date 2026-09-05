import test from 'node:test';
import assert from 'node:assert/strict';
import { memberModel } from '../src/models/Member.model.js';

// Opt in with MEMBER_PROFILE_DB_TESTS=1. Synthetic CTEs shadow the real tables;
// a read-only transaction also prevents accidental writes to the database.
test('member profiles tolerate pending and completed KYC reuse migrations', {
  skip: process.env.MEMBER_PROFILE_DB_TESTS !== '1',
}, async (t) => {
  const { default: pool } = await import('../src/config/db.js');
  const client = await pool.connect();
  try {
    await client.query('BEGIN READ ONLY');
    const fixture = ({ migrated = false, empty = false } = {}) => ({
      query: (sql, params) => client.query(`
        WITH members AS (SELECT 67 AS id, 'Test profile'::text AS full_name),
        kyc_cases AS (
          SELECT id, client_member_id, status, updated_at
                 ${migrated ? ', 100::integer AS reused_from_case_id' : ''}
          FROM (VALUES
            (1, 67, 'OPEN', '2026-09-05'::timestamp),
            (2, 67, 'VERIFIED', '2026-09-01'::timestamp)
          ) cases(id, client_member_id, status, updated_at)
          ${empty ? 'WHERE FALSE' : ''}
        ) ${sql}`, params),
    });

    await t.test('missing audit column still returns the strongest KYC status', async () => {
      const member = await memberModel.findByIdWithKyc(67, fixture());
      assert.equal(member.id, 67);
      assert.equal(member.shared_kyc_case_id, 2);
      assert.equal(member.shared_kyc_status, 'VERIFIED');
      assert.equal(member.shared_kyc_reused_from_case_id, null);
    });
    await t.test('migrated schema preserves the numeric reuse reference', async () => {
      const member = await memberModel.findByIdWithKyc(67, fixture({ migrated: true }));
      assert.equal(member.shared_kyc_reused_from_case_id, 100);
    });
    await t.test('profiles without KYC still load', async () => {
      const member = await memberModel.findByIdWithKyc(67, fixture({ empty: true }));
      assert.equal(member.id, 67);
      assert.equal(member.shared_kyc_case_id, null);
      assert.equal(member.shared_kyc_status, null);
    });
    await t.test('a missing member remains not found', async () => {
      assert.equal(await memberModel.findByIdWithKyc(999, fixture()), undefined);
    });
  } finally {
    await client.query('ROLLBACK');
    client.release();
    await pool.end();
  }
});
