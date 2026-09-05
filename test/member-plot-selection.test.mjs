import test from 'node:test';
import assert from 'node:assert/strict';
import { linkSelectedMemberPlot } from '../src/services/memberPlotSelection.service.js';

test('optional selection leaves existing plot links alone', async () => {
  for (const plotId of [undefined, null, '']) {
    await linkSelectedMemberPlot({ query: () => assert.fail('No database mutation expected') }, { plotId });
  }
});

test('invalid IDs cannot reach the database', async () => {
  for (const plotId of ['bad', '4abc', 0, -1, true, [], 1.5]) {
    await assert.rejects(linkSelectedMemberPlot({ query: () => assert.fail() }, { plotId }), { statusCode: 400 });
  }
});

test('missing or other-site plots and conflicting buyers cannot be reassigned', async () => {
  for (const plot of [undefined, { id: 420, buyer_member_id: 233 }]) {
    let calls = 0;
    await assert.rejects(linkSelectedMemberPlot({ query: async (_sql, params) => {
      calls++;
      assert.deepEqual(params, [420, 5]);
      return { rows: plot ? [plot] : [] };
    } }, { plotId: '420', memberId: 53, siteId: 5 }), { statusCode: plot ? 409 : 400 });
    assert.equal(calls, 1);
  }
});

test('unlinked and already-owned plots link using the exact member and site', async () => {
  for (const buyer of [null, 53]) {
    let calls = 0;
    await linkSelectedMemberPlot({ query: async (sql, params) => {
      calls++;
      if (calls === 1) {
        assert.match(sql, /FOR UPDATE/);
        return { rows: [{ id: 420, buyer_member_id: buyer }] };
      }
      assert.deepEqual(params, [420, 53, 5]);
      return { rows: [{ id: 420 }] };
    } }, { plotId: '420', memberId: 53, siteId: 5 });
    assert.equal(calls, 2);
  }
});

test('a pending migration produces an actionable error for the transaction to roll back', async () => {
  let calls = 0;
  await assert.rejects(linkSelectedMemberPlot({ query: async () => {
    if (++calls === 1) return { rows: [{ id: 420, buyer_member_id: null }] };
    throw Object.assign(new Error('missing column'), { code: '42703' });
  } }, { plotId: 420, memberId: 53, siteId: 5 }), { statusCode: 409 });
});
