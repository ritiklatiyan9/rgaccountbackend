import test from 'node:test';
import assert from 'node:assert/strict';
import { plotModel } from '../src/models/Plot.model.js';

test('customer name lookup retains plot nominee details and site-scoped owner links', async () => {
  const expected = { id: 22, buyer_name: 'TEST BUYER', nominee_name: 'TEST NOMINEE', nominee_relation: 'Spouse', nominee_phone: '9000000000' };
  const rows = await plotModel.searchByPerson(10, ' Test Buyer ', {
    query: async (sql, params) => {
      assert.deepEqual(params, [10, '%Test Buyer%', null]);
      assert.match(sql, /p\.site_id = \$1/);
      assert.match(sql, /m\.site_id = p\.site_id/);
      assert.match(sql, /b\.client_member_id = m\.id/);
      assert.match(sql, /p\.nominee_name, p\.nominee_relation, p\.nominee_phone/);
      return { rows: [expected] };
    },
  });
  assert.deepEqual(rows, [expected]);
});

test('phone lookup normalizes formatting without treating names as an empty phone match', async () => {
  await plotModel.searchByPerson(10, '+91 90000-00000', {
    query: async (sql, params) => {
      assert.deepEqual(params, [10, '%+91 90000-00000%', '%919000000000%']);
      assert.match(sql, /\$3::text IS NOT NULL/);
      assert.match(sql, /regexp_replace\(m\.phone/);
      return { rows: [] };
    },
  });
});

test('search input stays parameterized rather than entering the SQL statement', async () => {
  const input = "O'Neil";
  await plotModel.searchByPerson(7, input, {
    query: async (sql, params) => {
      assert.equal(sql.includes(input), false);
      assert.equal(params[1], "%O'Neil%");
      return { rows: [] };
    },
  });
});

test('empty and one-character person searches do not query the database', async () => {
  for (const query of ['', '  ', 'A']) {
    assert.deepEqual(await plotModel.searchByPerson(10, query, {
      query: async () => { assert.fail('Unexpected database query'); },
    }), []);
  }
});
