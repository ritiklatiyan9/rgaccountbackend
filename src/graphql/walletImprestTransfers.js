import {
  GraphQLObjectType, GraphQLString, GraphQLBoolean, GraphQLInt,
  GraphQLID, GraphQLList, GraphQLNonNull, GraphQLError,
} from 'graphql';
import { walletImprestAccess, listWalletImprestTransfers, walletImprestParticipants } from '../services/walletImprestTransfer.service.js';
import { cacheEnabled, cacheGet, cacheSet, getCacheGeneration } from '../config/cache.js';
import { walletReadTransaction } from '../services/walletRead.service.js';
import pool from '../config/db.js';

const timestamp = field => ({ type: GraphQLString, resolve: row => row[field] == null ? null : new Date(row[field]).toISOString() });
const TransferType = new GraphQLObjectType({
  name: 'WalletImprestTransfer',
  fields: {
    ...Object.fromEntries(['id','site_id','from_user_id','to_user_id','requested_by','resolved_by'].map(key => [key, { type: GraphQLID }])),
    ...Object.fromEntries(['amount','note','status','resolution_note','sender_acceptance_note','recipient_acceptance_note','from_user_name','to_user_name','requested_by_name'].map(key => [key, { type: GraphQLString }])),
    ...Object.fromEntries(['can_accept','can_reject','can_cancel'].map(key => [key, { type: GraphQLBoolean }])),
    ...Object.fromEntries(['created_at','resolved_at','sender_accepted_at','recipient_accepted_at'].map(key => [key, timestamp(key)])),
  },
});
const ParticipantType = new GraphQLObjectType({
  name: 'WalletImprestParticipant',
  fields: {
    id: { type: GraphQLID }, name: { type: GraphQLString }, role: { type: GraphQLString },
    can_send: { type: GraphQLBoolean }, can_fund: { type: GraphQLBoolean }, can_receive: { type: GraphQLBoolean },
    available_balance: { type: GraphQLString }, receive_reason: { type: GraphQLString },
  },
});
const PaginationType = new GraphQLObjectType({
  name: 'WalletImprestPagination',
  fields: Object.fromEntries(['totalItems','currentPage','totalPages','itemsPerPage'].map(key => [key, { type: GraphQLInt }])),
});
const WorkspaceType = new GraphQLObjectType({
  name: 'WalletImprestWorkspace',
  fields: {
    site_id: { type: new GraphQLNonNull(GraphQLID) },
    transfers: { type: new GraphQLList(TransferType) },
    pagination: { type: PaginationType },
    participants: { type: new GraphQLList(ParticipantType) },
  },
});

// Reuse the mutation service's live authorization for every read, including a
// cache hit. Amounts stay decimal strings; the cache never authorizes posting.
export function createWalletImprestWorkspaceResolver({
  authorize = walletImprestAccess, list = listWalletImprestTransfers, participants = walletImprestParticipants,
  database = pool, read = walletReadTransaction,
  cache = { enabled: cacheEnabled, get: cacheGet, set: cacheSet, generation: getCacheGeneration },
} = {}) {
  return async (_root, args, ctx) => {
    if (!ctx?.user) throw new GraphQLError('Authentication required', { extensions: { code: 'UNAUTHENTICATED' } });
    const query = { site_id: args.siteId, status: args.status ?? 'all', page: args.page ?? 1, limit: args.limit ?? 10, attention_only: args.attentionOnly === true };
    // Validate filters before constructing keys so equivalent requests share
    // one bounded cache entry and malformed pages cannot bypass service checks.
    if (!['all','pending','accepted','rejected','cancelled'].includes(query.status)
      || !Number.isInteger(query.page) || query.page < 1 || !Number.isInteger(query.limit) || query.limit < 1 || query.limit > 100) {
      throw new GraphQLError('Choose valid transfer filters', { extensions: { code: 'BAD_USER_INPUT' } });
    }
    try {
      const access = await authorize(ctx.user, args.siteId, database);
      const actor = access.actor;
      const key = `wallet-imprest|${JSON.stringify([actor.organization_id,actor.id,actor.role,actor.wallet_can_read,actor.wallet_view_all,actor.token_version,access.siteId,query.status,query.page,query.limit,query.attention_only,!!args.includeParticipants])}`;
      const generation = cache.generation();
      const enabled = cache.enabled();
      if (enabled) {
        const existing = await cache.get(key);
        if (existing && generation === cache.generation()) return existing;
      }
      const result = await read(database, async db => {
        const history = await list(ctx.user, query, db, access);
        const directory = args.includeParticipants ? await participants(ctx.user, query, db, access) : null;
        return { ...history, participants: directory?.participants || [] };
      }, { repeatableRead: true });
      if (enabled && generation === cache.generation()) await cache.set(key, result, 3);
      return result;
    } catch (error) {
      if (error instanceof GraphQLError) throw error;
      if (error.statusCode) throw new GraphQLError(error.message, { extensions: {
        code: error.statusCode === 403 ? 'FORBIDDEN' : error.statusCode === 404 ? 'NOT_FOUND' : 'BAD_USER_INPUT',
      } });
      throw error;
    }
  };
}

export const walletImprestQueryFields = {
  walletImprestTransfers: {
    type: WorkspaceType,
    args: {
      siteId: { type: new GraphQLNonNull(GraphQLID) }, status: { type: GraphQLString },
      page: { type: GraphQLInt }, limit: { type: GraphQLInt }, includeParticipants: { type: GraphQLBoolean }, attentionOnly: { type: GraphQLBoolean },
    },
    resolve: createWalletImprestWorkspaceResolver(),
  },
};
