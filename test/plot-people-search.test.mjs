import test from 'node:test';
import assert from 'node:assert/strict';
import { findPeopleByPlot, groupPlotPeople } from '../src/services/plotPeople.service.js';

test('plot lookup is exact, parameterized and site-scoped across relationship sources', async () => {
  const result = await findPeopleByPlot(10, ' a32 ', {
    query: async (sql, params) => {
      assert.deepEqual(params, [10, 'A32']);
      assert.match(sql, /p\.site_id = \$1 AND UPPER\(p\.plot_no\) = UPPER\(\$2\)/);
      assert.doesNotMatch(sql, /ILIKE/);
      assert.match(sql, /LEFT JOIN members m ON m\.site_id = \$1/);
      for (const source of ['bookings', 'plot_commissions_v2', 'plot_payments', 'plot_registries', 'plot_owners']) {
        assert.ok(sql.includes(source));
      }
      return { rows: [{ member_id: 7, full_name: 'Buyer', phone: '9000000000', role: 'Buyer' }] };
    },
  });
  assert.deepEqual(result.members[0].plot_roles, ['Buyer']);
});

test('one registered person appears once with all roles across plot history', () => {
  const result = groupPlotPeople([
    { member_id: 7, full_name: 'Buyer', phone: '9000000000', role: 'Buyer' },
    { member_id: 7, full_name: 'Buyer', phone: '9000000000', role: 'Booking client' },
    { member_id: 7, full_name: 'Buyer', phone: '9000000000', role: 'Buyer' },
  ]);
  assert.equal(result.members.length, 1);
  assert.deepEqual(result.members[0].plot_roles, ['Buyer', 'Booking client']);
});

test('unregistered nominees remain visible without becoming actionable member rows', () => {
  const result = groupPlotPeople([
    { member_id: null, full_name: 'Nominee', phone: '90000 00001', role: 'Plot nominee' },
    { member_id: null, full_name: 'Nominee', phone: '9000000001', role: 'KYC nominee' },
    { member_id: null, full_name: '', phone: '', role: 'Buyer' },
  ]);
  assert.equal(result.members.length, 0);
  assert.equal(result.contacts.length, 1);
  assert.equal(result.contacts[0].id, null);
  assert.deepEqual(result.contacts[0].plot_roles, ['Plot nominee', 'KYC nominee']);
});

test('empty plot lookup does not scan the database', async () => {
  assert.deepEqual(await findPeopleByPlot(10, ' ', {
    query: async () => assert.fail('Unexpected query'),
  }), { members: [], contacts: [] });
});
