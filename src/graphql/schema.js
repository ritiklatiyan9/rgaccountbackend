/**
 * GraphQL Schema — Dashboard Analytics BFF.
 * Runs alongside existing REST API on /graphql.
 */
import {
  GraphQLSchema, GraphQLObjectType, GraphQLString, GraphQLFloat,
  GraphQLBoolean, GraphQLList, GraphQLNonNull, GraphQLInputObjectType,
  GraphQLEnumType, GraphQLInt, GraphQLID,
} from 'graphql';
import { getAllKpis } from './services/kpi.service.js';
import { verifyFinancialIntegrity, getQueryDescriptions } from './services/consistency.service.js';
import { getRevenueVsExpense, getProfitTrend, getExpenseByCategory } from './services/charts.service.js';
import { getPlotPageData, getPlotPaymentDetail, getRegistryBankChequePayments } from './services/plotPayments.service.js';
import { cacheGet, cacheSet, cacheEnabled, clearCacheByPrefixes } from '../config/cache.js';

// ── Input types ──

const DateRangeInput = new GraphQLInputObjectType({
  name: 'DateRange',
  fields: {
    start: { type: new GraphQLNonNull(GraphQLString) },
    end:   { type: new GraphQLNonNull(GraphQLString) },
  },
});

const ResolutionEnum = new GraphQLEnumType({
  name: 'Resolution',
  values: {
    DAY:     { value: 'DAY' },
    WEEK:    { value: 'WEEK' },
    MONTH:   { value: 'MONTH' },
    QUARTER: { value: 'QUARTER' },
    YEAR:    { value: 'YEAR' },
  },
});

// ── Output types ──

const DiscrepancyType = new GraphQLObjectType({
  name: 'Discrepancy',
  fields: {
    kpi:       { type: new GraphQLNonNull(GraphQLString) },
    runAValue: { type: new GraphQLNonNull(GraphQLFloat) },
    runBValue: { type: new GraphQLNonNull(GraphQLFloat) },
    diff:      { type: new GraphQLNonNull(GraphQLFloat) },
    severity:  { type: new GraphQLNonNull(GraphQLString) },
  },
});

const KpiRunType = new GraphQLObjectType({
  name: 'KpiRun',
  fields: {
    totalRevenue:  { type: new GraphQLNonNull(GraphQLFloat) },
    totalExpense:  { type: new GraphQLNonNull(GraphQLFloat) },
    netProfit:     { type: new GraphQLNonNull(GraphQLFloat) },
    profitMargin:  { type: new GraphQLNonNull(GraphQLFloat) },
    outstanding:   { type: new GraphQLNonNull(GraphQLFloat) },
    cashflow:      { type: new GraphQLNonNull(GraphQLFloat) },
  },
});

const QueryDescType = new GraphQLObjectType({
  name: 'QueryDescription',
  fields: {
    runA:    { type: GraphQLString },
    runB:    { type: GraphQLString },
    formula: { type: GraphQLString },
  },
});

const VerificationType = new GraphQLObjectType({
  name: 'ConsistencyResult',
  fields: {
    passed:        { type: new GraphQLNonNull(GraphQLBoolean) },
    runA:          { type: new GraphQLNonNull(KpiRunType) },
    runB:          { type: new GraphQLNonNull(KpiRunType) },
    discrepancies: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(DiscrepancyType))) },
    checkedAt:     { type: new GraphQLNonNull(GraphQLString) },
    queriesUsed:   { type: GraphQLString }, // JSON string of query descriptions
  },
});

const CashflowDetailType = new GraphQLObjectType({
  name: 'CashflowDetail',
  fields: {
    incoming: { type: new GraphQLNonNull(GraphQLFloat) },
    outgoing: { type: new GraphQLNonNull(GraphQLFloat) },
    net:      { type: new GraphQLNonNull(GraphQLFloat) },
  },
});

const OutstandingDetailType = new GraphQLObjectType({
  name: 'OutstandingDetail',
  fields: {
    given:    { type: new GraphQLNonNull(GraphQLFloat) },
    returned: { type: new GraphQLNonNull(GraphQLFloat) },
    pending:  { type: new GraphQLNonNull(GraphQLFloat) },
  },
});

const BreakdownItemType = new GraphQLObjectType({
  name: 'BreakdownItem',
  fields: {
    module: { type: new GraphQLNonNull(GraphQLString) },
    debit:  { type: new GraphQLNonNull(GraphQLFloat) },
    credit: { type: new GraphQLNonNull(GraphQLFloat) },
    count:  { type: new GraphQLNonNull(GraphQLInt) },
  },
});

const KpiCardsType = new GraphQLObjectType({
  name: 'KpiCards',
  fields: {
    totalRevenue:      { type: new GraphQLNonNull(GraphQLFloat) },
    totalExpense:      { type: new GraphQLNonNull(GraphQLFloat) },
    netProfit:         { type: new GraphQLNonNull(GraphQLFloat) },
    profitMargin:      { type: new GraphQLNonNull(GraphQLFloat) },
    outstanding:       { type: new GraphQLNonNull(GraphQLFloat) },
    cashflow:          { type: new GraphQLNonNull(GraphQLFloat) },
    breakdown:         { type: new GraphQLList(BreakdownItemType) },
    cashflowDetail:    { type: CashflowDetailType },
    outstandingDetail: { type: OutstandingDetailType },
  },
});

const ChartPointType = new GraphQLObjectType({
  name: 'ChartPoint',
  fields: {
    date:    { type: new GraphQLNonNull(GraphQLString) },
    label:   { type: new GraphQLNonNull(GraphQLString) },
    value:   { type: GraphQLFloat },
    revenue: { type: GraphQLFloat },
    expense: { type: GraphQLFloat },
  },
});

const CategoryExpenseType = new GraphQLObjectType({
  name: 'CategoryExpense',
  fields: {
    category: { type: new GraphQLNonNull(GraphQLString) },
    amount:   { type: new GraphQLNonNull(GraphQLFloat) },
  },
});

// ── Plot Payment Types ──

const PlotMemberType = new GraphQLObjectType({
  name: 'PlotMember',
  fields: {
    name:       { type: new GraphQLNonNull(GraphQLString) },
    phone:      { type: GraphQLString },
    team:       { type: GraphQLString },
    memberType: { type: GraphQLString },
  },
});

const PlotAutocompleteType = new GraphQLObjectType({
  name: 'PlotAutocomplete',
  fields: {
    buyerNames:   { type: new GraphQLList(GraphQLString) },
    paymentFroms: { type: new GraphQLList(GraphQLString) },
    bankDetails:  { type: new GraphQLList(GraphQLString) },
    narrations:   { type: new GraphQLList(GraphQLString) },
    receivedBys:  { type: new GraphQLList(GraphQLString) },
    bookedBys:    { type: new GraphQLList(GraphQLString) },
    members:      { type: new GraphQLList(PlotMemberType) },
  },
});

const PlotType = new GraphQLObjectType({
  name: 'Plot',
  fields: {
    id:                  { type: new GraphQLNonNull(GraphQLID) },
    site_id:             { type: GraphQLInt },
    plot_no:             { type: GraphQLString },
    block:               { type: GraphQLString },
    buyer_name:          { type: GraphQLString },
    plot_size:           { type: GraphQLFloat },
    plot_size_mtr:       { type: GraphQLFloat },
    plot_rate:           { type: GraphQLFloat },
    sale_price:          { type: GraphQLFloat },
    registry_area:       { type: GraphQLFloat },
    circle_rate:         { type: GraphQLFloat },
    to_receive_bank:     { type: GraphQLFloat },
    first_installment:   { type: GraphQLFloat },
    booking_by:          { type: GraphQLString },
    booking_date:        { type: GraphQLString },
    status:              { type: GraphQLString },
    notes:               { type: GraphQLString },
    plot_tag:            { type: GraphQLString },
    team:                { type: GraphQLString },
    plot_commission:     { type: GraphQLFloat },
    commission_enabled:  { type: GraphQLBoolean },
    commission_type:     { type: GraphQLString },
    commission_value:    { type: GraphQLFloat },
    commission_rate:     { type: GraphQLFloat },
    original_plot_rate:  { type: GraphQLFloat },
    discount_rate:       { type: GraphQLFloat },
    plc_charges:         { type: GraphQLFloat },
    installments_enabled: { type: GraphQLBoolean },
    interest_enabled:    { type: GraphQLBoolean },
    interest_rate:       { type: GraphQLFloat },
    interest_type:       { type: GraphQLString },
    grace_period_days:   { type: GraphQLInt },
    free_to_sale_days:   { type: GraphQLInt },
    assigned_admin_id:   { type: GraphQLInt },
    created_by:          { type: GraphQLInt },
    created_at:          { type: GraphQLString },
    updated_at:          { type: GraphQLString },
    // Payment aggregates
    total_received:        { type: GraphQLFloat },
    received_bank:         { type: GraphQLFloat },
    received_cash:         { type: GraphQLFloat },
    payment_count:         { type: GraphQLInt },
    payment_buyer_names:   { type: GraphQLString },
    payment_booked_bys:    { type: GraphQLString },
  },
});

const PlotPageDataType = new GraphQLObjectType({
  name: 'PlotPageData',
  fields: {
    plots:        { type: new GraphQLList(PlotType) },
    autocomplete: { type: PlotAutocompleteType },
  },
});

const PlotPaymentType = new GraphQLObjectType({
  name: 'PlotPayment',
  fields: {
    id:                { type: new GraphQLNonNull(GraphQLID) },
    plot_id:           { type: GraphQLInt },
    site_id:           { type: GraphQLInt },
    date:              { type: GraphQLString },
    payment_from:      { type: GraphQLString },
    payment_type:      { type: GraphQLString },
    bank_details:      { type: GraphQLString },
    bank_name:         { type: GraphQLString },
    branch:            { type: GraphQLString },
    narration:         { type: GraphQLString },
    amount:            { type: GraphQLFloat },
    voucher_url:       { type: GraphQLString },
    assigned_admin_id: { type: GraphQLInt },
    buyer_name:        { type: GraphQLString },
    booked_by:         { type: GraphQLString },
    received_by:       { type: GraphQLString },
    cheque_no:         { type: GraphQLString },
    cheque_status:     { type: GraphQLString },
    status:            { type: GraphQLString },
    approved_by:       { type: GraphQLInt },
    approved_at:       { type: GraphQLString },
    created_by:        { type: GraphQLInt },
    created_by_name:   { type: GraphQLString },
    created_at:        { type: GraphQLString },
    source:            { type: GraphQLString },
  },
});

const PaymentBreakdownType = new GraphQLObjectType({
  name: 'PaymentBreakdown',
  fields: {
    payment_from: { type: GraphQLString },
    received_by:  { type: GraphQLString },
    entries:      { type: GraphQLInt },
    total_amount: { type: GraphQLFloat },
  },
});

const PlotInstallmentType = new GraphQLObjectType({
  name: 'PlotInstallment',
  fields: {
    id:               { type: new GraphQLNonNull(GraphQLID) },
    plot_id:          { type: GraphQLInt },
    installment_name: { type: GraphQLString },
    amount:           { type: GraphQLFloat },
    due_date:         { type: GraphQLString },
    sort_order:       { type: GraphQLInt },
    paid_amount:      { type: GraphQLFloat },
    created_at:       { type: GraphQLString },
  },
});

const PlotPaymentDetailType = new GraphQLObjectType({
  name: 'PlotPaymentDetail',
  fields: {
    payments:              { type: new GraphQLList(PlotPaymentType) },
    plot:                  { type: PlotType },
    fromBreakdown:         { type: new GraphQLList(PaymentBreakdownType) },
    receivedByBreakdown:   { type: new GraphQLList(PaymentBreakdownType) },
    installments:          { type: new GraphQLList(PlotInstallmentType) },
  },
});

const RegistryLinkablePaymentType = new GraphQLObjectType({
  name: 'RegistryLinkablePayment',
  fields: {
    id:                        { type: new GraphQLNonNull(GraphQLID) },
    plot_id:                   { type: GraphQLInt },
    plot_no:                   { type: GraphQLString },
    customer_name:             { type: GraphQLString },
    customer_phone:            { type: GraphQLString },
    date:                      { type: GraphQLString },
    amount:                    { type: GraphQLFloat },
    payment_type:              { type: GraphQLString },
    payment_from:              { type: GraphQLString },
    narration:                 { type: GraphQLString },
    bank_details:              { type: GraphQLString },
    mapped_registry_payment_id: { type: GraphQLInt },
  },
});

// ── Cache helpers ──
const CACHE_TTL = 120; // 2 minutes for dashboard data

function cacheKey(prefix, siteId, start, end) {
  return `dashboard:${prefix}:${siteId}:${start}:${end}`;
}

// ── Root Query ──

const QueryType = new GraphQLObjectType({
  name: 'Query',
  fields: {
    kpiCards: {
      type: KpiCardsType,
      args: {
        siteId: { type: new GraphQLNonNull(GraphQLID) },
        range:  { type: new GraphQLNonNull(DateRangeInput) },
        excludeOldPlots: { type: GraphQLBoolean },
      },
      async resolve(_, { siteId, range, excludeOldPlots = false }, ctx) {
        if (!ctx.user) throw new Error('Authentication required');
        const id = parseInt(siteId);
        const key = cacheKey(`kpi${excludeOldPlots ? '-new' : ''}`, id, range.start, range.end);

        if (cacheEnabled()) {
          const cached = await cacheGet(key);
          if (cached) return cached;
        }

        const result = await getAllKpis(id, range.start, range.end, excludeOldPlots);

        // Transform breakdown object → array for GraphQL
        const breakdownArr = Object.entries(result.breakdown).map(([mod, v]) => ({
          module: mod,
          debit: v.debit || 0,
          credit: v.credit || 0,
          count: v.count || 0,
        }));

        const response = { ...result, breakdown: breakdownArr };
        if (cacheEnabled()) await cacheSet(key, response, CACHE_TTL);
        return response;
      },
    },

    verifyFinancialIntegrity: {
      type: VerificationType,
      args: {
        siteId: { type: new GraphQLNonNull(GraphQLID) },
        range:  { type: new GraphQLNonNull(DateRangeInput) },
      },
      async resolve(_, { siteId, range }, ctx) {
        if (!ctx.user) throw new Error('Authentication required');
        if (ctx.user.role !== 'admin' && ctx.user.role !== 'super_admin') {
          throw new Error('Admin access required for verification');
        }
        const result = await verifyFinancialIntegrity(parseInt(siteId), range.start, range.end);
        return {
          ...result,
          queriesUsed: JSON.stringify(result.queriesUsed),
        };
      },
    },

    revenueVsExpense: {
      type: new GraphQLList(ChartPointType),
      args: {
        siteId:     { type: new GraphQLNonNull(GraphQLID) },
        range:      { type: new GraphQLNonNull(DateRangeInput) },
        resolution: { type: ResolutionEnum },
        excludeOldPlots: { type: GraphQLBoolean },
      },
      async resolve(_, { siteId, range, resolution = 'MONTH', excludeOldPlots = false }, ctx) {
        if (!ctx.user) throw new Error('Authentication required');
        const id = parseInt(siteId);
        const key = cacheKey(`chart-rve-${resolution}${excludeOldPlots ? '-new' : ''}`, id, range.start, range.end);

        if (cacheEnabled()) {
          const cached = await cacheGet(key);
          if (cached) return cached;
        }

        const data = await getRevenueVsExpense(id, range.start, range.end, resolution, excludeOldPlots);
        if (cacheEnabled()) await cacheSet(key, data, CACHE_TTL);
        return data;
      },
    },

    profitTrend: {
      type: new GraphQLList(ChartPointType),
      args: {
        siteId:     { type: new GraphQLNonNull(GraphQLID) },
        range:      { type: new GraphQLNonNull(DateRangeInput) },
        resolution: { type: ResolutionEnum },
        excludeOldPlots: { type: GraphQLBoolean },
      },
      async resolve(_, { siteId, range, resolution = 'MONTH', excludeOldPlots = false }, ctx) {
        if (!ctx.user) throw new Error('Authentication required');
        const id = parseInt(siteId);
        const key = cacheKey(`chart-profit-${resolution}${excludeOldPlots ? '-new' : ''}`, id, range.start, range.end);

        if (cacheEnabled()) {
          const cached = await cacheGet(key);
          if (cached) return cached;
        }

        const data = await getProfitTrend(id, range.start, range.end, resolution, excludeOldPlots);
        if (cacheEnabled()) await cacheSet(key, data, CACHE_TTL);
        return data;
      },
    },

    expensesByCategory: {
      type: new GraphQLList(CategoryExpenseType),
      args: {
        siteId: { type: new GraphQLNonNull(GraphQLID) },
        range:  { type: new GraphQLNonNull(DateRangeInput) },
        top:    { type: GraphQLInt },
      },
      async resolve(_, { siteId, range, top = 8 }, ctx) {
        if (!ctx.user) throw new Error('Authentication required');
        const data = await getExpenseByCategory(parseInt(siteId), range.start, range.end, top);
        return data;
      },
    },

    // ── Plot Payments queries ──

    plotPageData: {
      type: PlotPageDataType,
      args: {
        siteId: { type: new GraphQLNonNull(GraphQLID) },
      },
      async resolve(_, { siteId }, ctx) {
        if (!ctx.user) throw new Error('Authentication required');
        const id = parseInt(siteId);
        const key = `plots:pageData:${id}`;

        if (cacheEnabled()) {
          const cached = await cacheGet(key);
          if (cached) return cached;
        }

        const data = await getPlotPageData(id);

        if (cacheEnabled()) await cacheSet(key, data, 60); // 1 min cache
        return data;
      },
    },

    plotPaymentDetail: {
      type: PlotPaymentDetailType,
      args: {
        plotId: { type: new GraphQLNonNull(GraphQLID) },
        siteId: { type: new GraphQLNonNull(GraphQLID) },
      },
      async resolve(_, { plotId, siteId }, ctx) {
        if (!ctx.user) throw new Error('Authentication required');
        const data = await getPlotPaymentDetail(parseInt(plotId), parseInt(siteId));
        return data;
      },
    },

    registryBankChequePayments: {
      type: new GraphQLList(RegistryLinkablePaymentType),
      args: {
        siteId: { type: new GraphQLNonNull(GraphQLID) },
      },
      async resolve(_, { siteId }, ctx) {
        if (!ctx.user) throw new Error('Authentication required');
        return getRegistryBankChequePayments(parseInt(siteId));
      },
    },
  },
});

// ── Mutation: invalidate dashboard cache ──
const MutationType = new GraphQLObjectType({
  name: 'Mutation',
  fields: {
    invalidateDashboardCache: {
      type: GraphQLBoolean,
      args: {
        siteId: { type: new GraphQLNonNull(GraphQLID) },
      },
      async resolve(_, { siteId }, ctx) {
        if (!ctx.user) throw new Error('Authentication required');
        await clearCacheByPrefixes([`dashboard:*:${siteId}:`]);
        return true;
      },
    },

    invalidatePlotCache: {
      type: GraphQLBoolean,
      args: {
        siteId: { type: new GraphQLNonNull(GraphQLID) },
      },
      async resolve(_, { siteId }, ctx) {
        if (!ctx.user) throw new Error('Authentication required');
        await clearCacheByPrefixes([`plots:pageData:${siteId}`]);
        return true;
      },
    },
  },
});

export const schema = new GraphQLSchema({
  query: QueryType,
  mutation: MutationType,
});
