import test from 'node:test';
import assert from 'node:assert/strict';
import { createWalletImprestWorkspaceResolver, walletImprestQueryFields } from '../src/graphql/walletImprestTransfers.js';
import { graphql, GraphQLSchema, GraphQLObjectType } from 'graphql';

function setup() {
  let actor = { id: 7, organization_id: 2, role: 'sub_admin', wallet_view_all: false };
  let allowed = true, generation = 0, reads = 0, authorizations = 0;
  const stored = new Map(), keys = [];
  const dependencies = {
    database: {},
    authorize: async () => { authorizations++; if (!allowed) throw Object.assign(new Error('Access revoked'), { statusCode: 403 }); return { actor, siteId: 5 }; },
    list: async (_user, query, _db, access) => { reads++; return { site_id: access.siteId, transfers: [{ id: 'request-1', amount: '900719925474.99' }], pagination: { currentPage: query.page, totalItems: 1 } }; },
    participants: async () => ({ participants: [{ id: 8, name: 'Staff', available_balance: null }] }),
    read: async (_db, run) => run({}),
    cache: { enabled: () => true, generation: () => generation, get: async key => stored.get(key), set: async (key, value, ttl) => { assert.equal(ttl, 3); keys.push(key); stored.set(key, value); } },
  };
  return { dependencies, stored, keys, stats: () => ({ reads, authorizations }),
    changeActor: value => { actor = { ...actor, ...value }; }, revoke: () => { allowed = false; }, invalidate: () => { generation++; stored.clear(); } };
}
const context = { user: { id: 7 } }, args = { siteId: '5' };

test('GraphQL shares a bounded read cache while rechecking current access and keeping decimal money', async () => {
  const fixture = setup(), resolve = createWalletImprestWorkspaceResolver(fixture.dependencies);
  const first = await resolve(null, args, context), second = await resolve(null, args, context);
  assert.deepEqual(first, second); assert.equal(first.transfers[0].amount, '900719925474.99');
  assert.deepEqual(first.participants, []); assert.deepEqual(fixture.stats(), { reads: 1, authorizations: 2 });
  fixture.revoke();
  await assert.rejects(resolve(null, args, context), error => error.extensions.code === 'FORBIDDEN');
});
test('GraphQL read scope changes with visibility and mutation invalidation', async () => {
  const fixture = setup(), resolve = createWalletImprestWorkspaceResolver(fixture.dependencies);
  await resolve(null, args, context);
  fixture.changeActor({ wallet_view_all: true });
  await resolve(null, args, context);
  assert.equal(fixture.stats().reads, 2);
  fixture.invalidate();
  const result = await resolve(null, { ...args, includeParticipants: true }, context);
  assert.equal(result.participants[0].available_balance, null); assert.equal(fixture.stats().reads, 3);
});
test('a read begun before a mutation never refills the GraphQL cache', async () => {
  const fixture = setup();
  fixture.dependencies.list = async () => { fixture.invalidate(); return { site_id: 5, transfers: [], pagination: {} }; };
  const resolve = createWalletImprestWorkspaceResolver(fixture.dependencies);
  await resolve(null, args, context);
  assert.equal(fixture.keys.length, 0);
});
test('GraphQL requires authentication and validates filters before reading', async () => {
  const fixture = setup(), resolve = createWalletImprestWorkspaceResolver(fixture.dependencies);
  await assert.rejects(resolve(null, args, {}), error => error.extensions.code === 'UNAUTHENTICATED');
  for (const filters of [{ status: 'invalid' }, { page: 0 }, { page: 1.5 }, { limit: 101 }]) {
    await assert.rejects(resolve(null, { ...args, ...filters }, context), error => error.extensions.code === 'BAD_USER_INPUT');
  }
  assert.equal(fixture.stats().reads, 0);
});
test('GraphQL workspace exposes both independent notes, timestamps and participant attention counts', async () => {
  const fixture = setup();
  fixture.dependencies.list = async (_user, query) => {
    assert.equal(query.attention_only, true);
    return { site_id: 5, transfers: [{ id: 'request-1', amount: '1000000.15',
      sender_accepted_at: new Date('2026-10-31T10:00:00Z'), recipient_accepted_at: null,
      sender_acceptance_note: 'Cash ready', recipient_acceptance_note: '', can_accept: false }],
    pagination: { totalItems: 1, currentPage: 1, totalPages: 1, itemsPerPage: 10 } };
  };
  const schema = new GraphQLSchema({ query: new GraphQLObjectType({ name: 'Query', fields: {
    walletImprestTransfers: { ...walletImprestQueryFields.walletImprestTransfers, resolve: createWalletImprestWorkspaceResolver(fixture.dependencies) },
  } }) });
  const result = await graphql({ schema, contextValue: context, source: `query {
    walletImprestTransfers(siteId:"5",attentionOnly:true) {
      site_id pagination { totalItems }
      transfers { amount sender_accepted_at recipient_accepted_at sender_acceptance_note recipient_acceptance_note can_accept }
    }
  }` });
  assert.equal(result.errors, undefined);
  assert.equal(result.data.walletImprestTransfers.transfers[0].sender_accepted_at, '2026-10-31T10:00:00.000Z');
  assert.equal(result.data.walletImprestTransfers.transfers[0].sender_acceptance_note, 'Cash ready');
  assert.equal(result.data.walletImprestTransfers.transfers[0].amount, '1000000.15');
  assert.equal(result.data.walletImprestTransfers.pagination.totalItems, 1);
});
