import { up as migrateDealerNames } from '../src/migrations/243_plot_booking_dealer_names.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import pool from '../src/config/db.js';
import { withPlotBookingAllocations } from '../src/services/plotBookingAllocations.service.js';
import { installRequestTransactionAdapter } from '../src/services/requestTransactionContext.js';
import { commissionAllocationRevision } from '../src/services/commissionAllocations.service.js';
import { allocationSchemaSql } from '../src/migrations/241_plot_commission_allocations.js';

const user = { id: 1, role: 'admin', organization_id: 1 };
const split = values => values.map((value, index) => ({ agent_id: index + 1, allocation_type: 'percentage', allocation_value: value }));
test('Booking By and dealer money commit together, using stable member IDs and existing paid histories', async t => {
  const db = new PGlite();
  t.after(async () => { await db.close(); await pool.end(); });
  await db.exec(`CREATE TABLE sites(id int PRIMARY KEY,organization_id int);
    CREATE TABLE user_sites(user_id int,site_id int);
    CREATE TABLE members(id int PRIMARY KEY,site_id int,full_name text,phone text);
    CREATE TABLE plots(id serial PRIMARY KEY,site_id int,plot_no text,booking_by text,plot_size numeric,
      plot_commission numeric,commission_rate numeric,notes text,updated_at timestamptz DEFAULT NOW());
    CREATE TABLE plot_commissions_v2(id serial PRIMARY KEY,site_id int,plot_id int,agent_id int,total_commission numeric,
      remarks text,status text,created_by int,created_at timestamptz DEFAULT NOW(),updated_at timestamptz);
    CREATE TABLE plot_commission_payments(id serial PRIMARY KEY,site_id int,plot_commission_id int REFERENCES plot_commissions_v2(id) ON DELETE CASCADE,
      amount numeric,tds_amount numeric DEFAULT 0,status text,payment_mode text,cheque_status text,date date DEFAULT CURRENT_DATE);
    CREATE FUNCTION financial_transaction_posts(direction text,status text,mode text,cheque text) RETURNS boolean LANGUAGE SQL IMMUTABLE AS $$
      SELECT status='approved' AND COALESCE(cheque,'CLEARED') NOT IN ('PENDING','BOUNCED','RETURNED') $$;
    INSERT INTO sites VALUES(1,1),(2,1),(3,2);
    INSERT INTO members VALUES(1,1,'Same Name','111'),(2,1,'Same Name','222'),(3,2,'Other Site','333'),(4,3,'Foreign','444');`);
  await db.exec(allocationSchemaSql);
  let checkouts = 0, releaseCount = 0;
  const database = { query: (sql, args) => db.query(sql, args), connect: async () => {
    checkouts += 1;
    return { query: (sql, args) => db.query(sql, args), release() { releaseCount += 1; } };
  } };
  installRequestTransactionAdapter(database);
  const response = () => ({ statusCode: 200, delivered: null, status(code) { this.statusCode = code; return this; }, json(payload) { this.delivered = payload; return this; } });
  const create = withPlotBookingAllocations(async (req, res) => {
    const { rows: [plot] } = await database.query(`INSERT INTO plots(site_id,plot_no,booking_by,plot_size,plot_commission,commission_rate,notes)
      VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`, [1,'A2',req.body.booking_by,100,req.body.plot_commission,req.body.commission_rate,req.body.notes || 'Created']);
    res.status(201).json({ plot });
  }, { database });
  const draft = { total_commission: 1000, allocations: split([30,50,20]) };
  const created = response();
  await create({ body: { site_id: 1, plot_size: 100, booking_by: 'Spoofed name', booking_allocations: draft }, params: {}, user }, created);
  assert.equal(checkouts, 1, 'plot and allocation work use one checked out connection');
  assert.equal(releaseCount, 1);
  assert.equal(created.delivered.plot.booking_by, 'SAME NAME, SAME NAME, OTHER SITE');
  assert.equal(Number(created.delivered.plot.commission_rate), 10);
  const records = () => db.query('SELECT * FROM plot_commissions_v2 WHERE plot_id=1 ORDER BY agent_id').then(result => result.rows);
  const initial = await records();
  assert.deepEqual(initial.map(row => Number(row.total_commission)), [300,500,200]);
  assert.deepEqual(initial.map(row => row.agent_id), [1,2,3], 'duplicate names do not collapse identities');
  const revision = async () => commissionAllocationRevision((await db.query('SELECT * FROM plots WHERE id=1')).rows[0], await records());
  const edit = withPlotBookingAllocations(async (req, res) => {
    // Match PlotModel's nested transaction: it must remain a savepoint inside
    // the encompassing booking transaction, rather than commit early.
    const client = await database.connect();
    await client.query('BEGIN');
    const { rows: [plot] } = await client.query('UPDATE plots SET notes=$1,booking_by=$2,plot_commission=$3,commission_rate=COALESCE($4,commission_rate) WHERE id=$5 RETURNING *',
      [req.body.notes, req.body.booking_by, req.body.plot_commission, req.body.commission_rate ?? null, req.params.id]);
    await client.query('COMMIT'); client.release();
    res.json({ plot });
  }, { database });
  await db.query("INSERT INTO plot_commission_payments(site_id,plot_commission_id,amount,status,payment_mode) VALUES(1,$1,100,'approved','CASH')", [initial[0].id]);
  const beforeFailure = (await db.query('SELECT * FROM plots WHERE id=1')).rows[0];
  await assert.rejects(edit({ body: { notes: 'Must roll back', booking_allocations: { ...draft, revision: await revision(), allocations: split([5,75,20]) } }, params: { id: 1 }, user }, response()), /lower than/);
  assert.deepEqual((await db.query('SELECT * FROM plots WHERE id=1')).rows[0], beforeFailure);
  assert.deepEqual(await records(), initial);
  const currentRevision = await revision();
  const success = response();
  await edit({ body: { notes: 'Saved', booking_allocations: { ...draft, total_commission: 2000, revision: currentRevision } }, params: { id: 1 }, user }, success);
  assert.deepEqual((await records()).map(row => row.id), initial.map(row => row.id));
  assert.deepEqual((await records()).map(row => Number(row.total_commission)), [600,1000,400]);
  assert.equal((await db.query('SELECT COUNT(*)::int AS n FROM plot_commission_payments')).rows[0].n, 1);
  await db.query('UPDATE plots SET commission_rate=1.12345678 WHERE id=1');
  await edit({ body: { notes: 'Dealer remarks edit', booking_allocations: { ...draft, total_commission: 2000, revision: await revision() } }, params: { id: 1 }, user }, response());
  assert.equal((await db.query('SELECT commission_rate FROM plots WHERE id=1')).rows[0].commission_rate,'1.12345678');
  await assert.rejects(edit({ body: { notes: 'Stale', booking_allocations: { ...draft, revision: currentRevision } }, params: { id: 1 }, user }, response()), { statusCode: 409, code: 'COMMISSION_ALLOCATION_CONFLICT' });
  assert.equal((await db.query('SELECT notes FROM plots WHERE id=1')).rows[0].notes, 'Dealer remarks edit');
  await assert.rejects(create({ body: { site_id: 1, booking_allocations: { total_commission: 1000, allocations: [{ agent_id: 4, allocation_type: 'amount', allocation_value: 1000 }] } }, params: {}, user }, response()), /organization/);
  assert.equal((await db.query('SELECT COUNT(*)::int AS n FROM plots')).rows[0].n, 1);
  const reject = withPlotBookingAllocations(async (_req, res) => {
    await database.query("INSERT INTO plots(site_id,plot_no,plot_commission) VALUES(1,'INVALID',1000)");
    res.status(409).json({ message: 'Duplicate booking' });
  }, { database });
  const rejected = response();
  await reject({ body: { site_id: 1, booking_allocations: draft }, params: {}, user }, rejected);
  assert.equal(rejected.statusCode, 409);
  assert.equal((await db.query('SELECT COUNT(*)::int AS n FROM plots')).rows[0].n, 1);
  await assert.rejects(edit({ body: { notes: 'Cannot remove paid', booking_allocations: { ...draft, revision: await revision(), allocations: [] } }, params: { id: 1 }, user }, response()), /payment history/);
  const another = response();
  await create({ body: { site_id: 1, plot_size: 100, booking_allocations: draft }, params: {}, user }, another);
  const otherId = another.delivered.plot.id;
  const otherPlot = (await db.query('SELECT * FROM plots WHERE id=$1',[otherId])).rows[0];
  const otherMasters = (await db.query('SELECT * FROM plot_commissions_v2 WHERE plot_id=$1',[otherId])).rows;
  const cleared = response();
  await edit({ body: { notes: 'Cleared unpaid', booking_allocations: { ...draft, revision: commissionAllocationRevision(otherPlot,otherMasters), allocations: [] } }, params: { id: otherId }, user }, cleared);
  assert.equal(cleared.delivered.plot.booking_by, null);
  assert.equal((await db.query('SELECT COUNT(*)::int AS n FROM plot_commissions_v2 WHERE plot_id=$1',[otherId])).rows[0].n, 0);
});

test('ordinary zero-commission booking delegates without creating commission records', async () => {
  let called = false;
  const handler = withPlotBookingAllocations(async () => { called = true; }, { database: { connect() { throw new Error('No allocation transaction expected'); } } });
  await handler({ body: { booking_by: 'Legacy', plot_commission: 0 } }, {});
  assert.equal(called, true);
});


test('dealer-name migration preserves existing names and permits long multi-dealer displays', async () => {
  const db = new PGlite();
  try {
    await db.exec(`CREATE TABLE app_schema_migrations(version text PRIMARY KEY);
      CREATE TABLE plots(id int PRIMARY KEY,booking_by varchar(255));
      CREATE TABLE plot_payments(id int PRIMARY KEY,booked_by varchar(255),amount numeric);
      INSERT INTO plots VALUES(1,'Existing Dealer');
      INSERT INTO plot_payments VALUES(2,'Existing Dealer',123.45);`);
    const database = { connect: async () => ({ query: async (sql,args) => {
      if (sql.includes('ALTER TABLE plots')) { await db.exec(sql); return {rows:[]}; }
      return db.query(sql,args);
    }, release() {} }) };
    assert.equal(await migrateDealerNames(database),true);
    assert.equal(await migrateDealerNames(database),false);
    assert.equal((await db.query('SELECT booking_by FROM plots')).rows[0].booking_by,'Existing Dealer');
    assert.deepEqual((await db.query('SELECT booked_by,amount FROM plot_payments')).rows[0],{booked_by:'Existing Dealer',amount:'123.45'});
    const names=Array.from({length:100},(_,i)=>`Dealer ${i}`).join(', ');
    await db.query('UPDATE plots SET booking_by=$1',[names]);
    await db.query('UPDATE plot_payments SET booked_by=$1',[names]);
    assert.equal((await db.query('SELECT booking_by FROM plots')).rows[0].booking_by,names);
    assert.equal((await db.query('SELECT booked_by FROM plot_payments')).rows[0].booked_by,names);
  } finally { await db.close(); }
});
