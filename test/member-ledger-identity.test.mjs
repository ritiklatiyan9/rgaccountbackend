import assert from 'node:assert/strict';
import test from 'node:test';
import {
  uniqueMemberNameMatch, memberTransactionMatch,
  LEDGER_PLOT_BUYER_JOIN, MEMBER_PLOT_PAYMENT_MATCH,
} from '../src/services/memberLedgerIdentity.service.js';

// Synthetic CTEs shadow tables; even the optional database run cannot write data.
test('PostgreSQL keeps same-name client ledgers separate', {
  skip: process.env.MEMBER_LEDGER_DB_TEST !== '1' && 'Set MEMBER_LEDGER_DB_TEST=1 for read-only PostgreSQL tests',
}, async (t) => {
  const { default: pool } = await import('../src/config/db.js');
  const client = await pool.connect();
  const members = `members(id,site_id,full_name) AS (VALUES
    (53,5,'REENA'), (233,5,' reena '), (300,5,'Unique Buyer'),
    (301,6,'Unique Buyer'), (400,5,'Former Buyer'))`;
  const ids = async (sql, memberId) => (await client.query(sql, [5, memberId])).rows.map(r => r.id);
  try {
    await client.query('BEGIN READ ONLY');
    await t.test('assigned and mapped clients survive duplicate names; unlinked names do not', async () => {
      const sql = `WITH ${members},
        entries(id,site_id,assigned_user_id,mapped_member_id,mapped_user_id,to_entity,from_entity) AS (VALUES
          (1,5,53,NULL::integer,NULL::integer,'REENA','Office'),
          (2,5,233,NULL,NULL,'REENA','Office'),
          (3,5,NULL,53,NULL,'Old name','Office'),
          (4,5,NULL,233,NULL,'REENA','Office'),
          (5,5,NULL,NULL,NULL,'REENA','Office'),
          (6,5,NULL,NULL,NULL,' unique buyer ','Office'),
          (7,5,53,NULL,NULL,'Unique Buyer','Office'),
          (8,5,NULL,NULL,300,'Unique Buyer','Office'),
          (9,6,53,NULL,NULL,'REENA','Office'),
          (10,5,NULL,NULL,NULL,'Office','Unique Buyer'))
        SELECT e.id FROM entries e WHERE e.site_id=$1
          AND ${memberTransactionMatch('e', ['e.to_entity', 'e.from_entity'], { assigned: true })}
        ORDER BY e.id`;
      assert.deepEqual(await ids(sql, 53), [1, 3, 7]);
      assert.deepEqual(await ids(sql, 233), [2, 4]);
      assert.deepEqual(await ids(sql, 300), [6, 10]);
    });

    await t.test('firm mappings override names and legacy commissions require a unique name', async () => {
      const fixture = `WITH ${members}, entries(id,site_id,mapped_member_id,mapped_user_id,name) AS (VALUES
        (1,5,53,NULL::integer,'REENA'), (2,5,233,NULL,'REENA'),
        (3,5,NULL,NULL,'REENA'), (4,5,NULL,NULL,' Unique Buyer '),
        (5,5,53,NULL,'Unique Buyer'), (6,5,NULL,300,'Unique Buyer'))`;
      const firmSql = `${fixture} SELECT ft.id FROM entries ft WHERE ft.site_id=$1
        AND ${memberTransactionMatch('ft', ['ft.name'])} ORDER BY ft.id`;
      assert.deepEqual(await ids(firmSql, 53), [1, 5]);
      assert.deepEqual(await ids(firmSql, 233), [2]);
      assert.deepEqual(await ids(firmSql, 300), [4]);
      const legacySql = `${fixture} SELECT pc.id FROM entries pc WHERE pc.site_id=$1
        AND ${uniqueMemberNameMatch('pc.name')} ORDER BY pc.id`;
      assert.deepEqual(await ids(legacySql, 53), []);
      assert.deepEqual(await ids(legacySql, 233), []);
      assert.deepEqual(await ids(legacySql, 300), [4, 5, 6]);
    });

    for (const migrated of [false, true]) {
      await t.test(`plot payments respect buyers, bookings and resale history (buyer column: ${migrated})`, async () => {
        const sql = `WITH ${members},
          plot_data(id,site_id,buyer_name) AS (VALUES
            (1,5,'REENA'), (2,5,'REENA'), (3,5,'REENA'),
            (4,5,'Unique Buyer'), (5,5,'Unique Buyer'), (6,5,'REENA'), (7,6,'REENA')),
          plots AS (SELECT * ${migrated ? ', CASE WHEN id=6 THEN 53 END AS buyer_member_id' : ''} FROM plot_data),
          bookings(id,site_id,plot_id,client_member_id,status) AS (VALUES
            (1,5,1,53,'BOOKED'), (2,5,2,233,'BOOKED'), (3,5,1,233,'CANCELLED'),
            (4,5,6,233,'BOOKED'), (5,6,3,53,'BOOKED')),
          plot_payments(id,site_id,plot_id,buyer_name,mapped_member_id,mapped_user_id) AS (VALUES
            (1,5,1,NULL::text,NULL::integer,NULL::integer),
            (2,5,2,'REENA',NULL,NULL), (3,5,3,'REENA',NULL,NULL),
            (4,5,4,'Unique Buyer',NULL,NULL), (5,5,1,'Former Buyer',NULL,NULL),
            (6,5,2,'REENA',53,NULL), (7,5,5,'REENA',NULL,NULL),
            (8,5,6,NULL,NULL,NULL), (9,5,4,'Unique Buyer',NULL,300),
            (10,5,7,NULL,53,NULL))
          SELECT pp.id FROM plot_payments pp
          JOIN plots p ON p.id=pp.plot_id AND p.site_id=pp.site_id
          ${LEDGER_PLOT_BUYER_JOIN}
          WHERE pp.site_id=$1 AND ${MEMBER_PLOT_PAYMENT_MATCH} ORDER BY pp.id`;
        assert.deepEqual(await ids(sql, 53), migrated ? [1, 6, 8] : [1, 6]);
        assert.deepEqual(await ids(sql, 233), migrated ? [2] : [2, 8]);
        assert.deepEqual(await ids(sql, 300), [4]);
        assert.deepEqual(await ids(sql, 400), [5]);
      });
    }
  } finally {
    await client.query('ROLLBACK');
    client.release();
    await pool.end();
  }
});
