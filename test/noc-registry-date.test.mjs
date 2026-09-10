import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { nocRegistryDate } from '../src/utils/nocRegistryDate.js';
import { registryCoverageSql } from '../src/utils/registryCashAllocation.js';

test('registry dates preserve omissions, allow clearing, and reject invalid calendar dates', () => {
  assert.equal(nocRegistryDate(undefined, '2026-09-23'), '2026-09-23');
  assert.equal(nocRegistryDate(undefined, new Date(2026, 8, 23)), '2026-09-23');
  assert.equal(nocRegistryDate('', '2026-09-23'), null);
  assert.equal(nocRegistryDate(null, '2026-09-23'), null);
  assert.equal(nocRegistryDate('2028-02-29'), '2028-02-29');
  for (const value of ['2026-02-30', '2026-13-01', '23/09/2026', {}, true]) {
    assert.throws(() => nocRegistryDate(value), error => error.statusCode === 400);
  }
});

test('generating and regenerating persist registry date in the record and revision snapshot', { skip: !process.env.PGLITE_MODULE }, async () => {
  const { PGlite } = await import(process.env.PGLITE_MODULE);
  const db = new PGlite();
  try {
    await db.exec(`CREATE TABLE plot_registries (
      id integer PRIMARY KEY, site_id integer, plot_id integer, plot_no text, customer_name text,
      registry_payment numeric DEFAULT 0, registry_date date, noc_no text, noc_date date, noc_place text,
      noc_notes text, noc_show_payments boolean, noc_ack_no text, noc_revision integer,
      noc_generated_by integer, noc_include_co_applicant boolean, noc_farmer_member_id integer,
      noc_authorized_member_id integer, noc_farmer_member_ids integer[], noc_authorized_member_ids integer[],
      noc_client_member_ids integer[], noc_generated_at timestamptz, noc_approved_at timestamptz,
      noc_approved_by integer, updated_at timestamptz);
      CREATE TABLE plots(id integer PRIMARY KEY, site_id integer, plot_no text, status text, updated_at timestamptz);
      CREATE TABLE plot_registry_noc_history(registry_id integer, revision_no integer, ref_no text, ack_no text,
        event_type text, change_note text, show_payments boolean, included_payment_count integer,
        included_amount numeric, snapshot jsonb, generated_by integer, generated_at timestamptz);
      INSERT INTO plots VALUES (438,5,'A38','BOOKED',now());
      INSERT INTO plot_registries(id,site_id,plot_id,plot_no,customer_name) VALUES (693,5,438,'A38','Example buyer');`);
    const query = async (sql, params) => {
      if (sql.includes('AS total_paid')) return { rows: [{ total_paid: 0 }] };
      if (sql.includes('jsonb_agg(x.payment')) return { rows: [{ payments: [], included_count: 0, included_amount: 0 }] };
      if (sql.includes('FROM members')) return { rows: [] };
      return db.query(sql, params);
    };
    const record = async () => (await db.query('SELECT * FROM plot_registries WHERE id=693')).rows[0];
    const source = readFileSync(new URL('../src/controllers/registry.controller.js', import.meta.url), 'utf8');
    const start = source.indexOf('export const saveRegistryNoc =');
    const handler = source.slice(start, source.indexOf('\n// ═', start)).replace('export const', 'const');
    const ctx = vm.createContext({
      pool: { connect: async () => ({ query, release() {} }) }, asyncHandler: fn => fn, nocRegistryDate, registryCoverageSql,
      readRegistryWorkflowUnlocked: async () => false, readNocKycRequired: async () => false,
      COMPANY_MEMBER_TYPES: ['PARTNER', 'EMPLOYEE', 'MEMBER'],
      buildNocPayload: async () => ({ registry: await record() }),
    });
    vm.runInContext(`${handler}\nthis.save = saveRegistryNoc;`, ctx);
    const save = async body => {
      let result;
      await ctx.save({ params: { id: 693 }, user: { id: 7 }, body }, { json: value => { result = value; } });
      return result;
    };
    await assert.rejects(save({ registry_date: '2026-02-30' }), error => error.code === 'INVALID_REGISTRY_DATE');
    assert.equal((await record()).noc_generated_at, null);
    const created = await save({ noc_no: 'REF-693', noc_date: '2026-09-20', registry_date: '2026-09-23' });
    assert.equal(new Date(created.registry.registry_date).toISOString().slice(0, 10), '2026-09-23');
    await save({ noc_date: '2026-09-21', change_note: 'Certificate date corrected' });
    assert.equal(new Date((await record()).registry_date).toISOString().slice(0, 10), '2026-09-23');
    await save({ registry_date: '', change_note: 'Registry date cleared' });
    assert.equal((await record()).registry_date, null);
    const history = (await db.query('SELECT * FROM plot_registry_noc_history ORDER BY revision_no')).rows;
    assert.equal(history.length, 3);
    assert.equal(history[0].snapshot.noc.registry_date, '2026-09-23');
    assert.equal(String(history[1].snapshot.noc.registry_date).slice(0, 10), '2026-09-23');
    assert.equal(history[2].snapshot.noc.registry_date, null);
  } finally { await db.close(); }
});
