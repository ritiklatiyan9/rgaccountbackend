import test from 'node:test';
import assert from 'node:assert/strict';

import { plotModel } from '../src/models/Plot.model.js';

test('dashboard plot search uses exact equality and returns module summary fields', async () => {
  const expected = {
    id: 2,
    plot_no: 'A2',
    payment_count: 3,
    commission_count: 1,
    registry_count: 1,
    document_count: 2,
  };
  const pool = {
    query: async (sql, params) => {
      assert.match(sql, /UPPER\(plot_no\)\s*=\s*UPPER\(\$2\)/);
      assert.doesNotMatch(sql, /ILIKE/);
      assert.match(sql, /plot_commissions_v2/);
      assert.match(sql, /plot_registries/);
      assert.match(sql, /plot_payments/);
      assert.match(sql, /documents/);
      assert.deepEqual(params, [10, 'A2']);
      return { rows: [expected] };
    },
  };

  const rows = await plotModel.searchByPlotNo(10, ' A2 ', pool);
  assert.deepEqual(rows, [expected]);
});

test('empty plot search does not query the database', async () => {
  let queried = false;
  const rows = await plotModel.searchByPlotNo(10, '   ', {
    query: async () => { queried = true; return { rows: [] }; },
  });
  assert.deepEqual(rows, []);
  assert.equal(queried, false);
});
