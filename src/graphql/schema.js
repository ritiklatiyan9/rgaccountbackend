import { getConstructionSummaryData } from '../controllers/construction.controller.js';
import { constructionExpenseScope } from '../services/constructionExpenseScope.service.js';
/**
 * GraphQL Schema — Dashboard Analytics BFF.
 * Runs alongside existing REST API on /graphql.
 */
import {
  GraphQLSchema, GraphQLObjectType, GraphQLString, GraphQLFloat,
  GraphQLBoolean, GraphQLList, GraphQLNonNull, GraphQLInputObjectType,
  GraphQLEnumType, GraphQLInt, GraphQLID, GraphQLError,
} from 'graphql';
import { getAllKpis } from './services/kpi.service.js';
import { verifyFinancialIntegrity } from './services/consistency.service.js';
import { getRevenueVsExpense, getExpenseByCategory } from './services/charts.service.js';
import { readDashboardCache } from './services/dashboardCache.js';
import { selectedFields } from './selectedFields.js';
import { getExpensesPageData, getExpensesBreakdown } from './services/expenses.service.js';
import { getPlotPageData, getPlotPaymentDetail, getRegistryBankChequePayments } from './services/plotPayments.service.js';
import { getFinanceForecast } from './services/forecast.service.js';
import { cacheGet, cacheSet, cacheEnabled, clearCacheByPrefixes } from '../config/cache.js';
import pool from '../config/db.js';
import { inventoryModel } from '../models/Inventory.model.js';
import { buildProfitPortfolio } from '../services/profitPortfolio.service.js';
import { getProfitPortfolioSnapshot } from '../services/profitPortfolioSnapshot.service.js';
import { walletImprestQueryFields } from './walletImprestTransfers.js';

const PRIVILEGED_ROLES = new Set(['admin', 'super_admin']);

function requireModuleRead(ctx, module, rawSiteId) {
  if (!ctx?.user) {
    throw new GraphQLError('Authentication required', { extensions: { code: 'UNAUTHENTICATED' } });
  }

  const siteId = Number(rawSiteId);
  if (!Number.isInteger(siteId) || siteId <= 0) {
    throw new GraphQLError('A valid siteId is required', { extensions: { code: 'BAD_USER_INPUT' } });
  }

  if (PRIVILEGED_ROLES.has(ctx.user.role)) return siteId;
  if (ctx.user.role !== 'sub_admin') {
    throw new GraphQLError('Insufficient permissions', { extensions: { code: 'FORBIDDEN' } });
  }

  if (ctx.permissions?.get(module)?.can_read !== true) {
    throw new GraphQLError(`Read access to ${module} is required`, { extensions: { code: 'FORBIDDEN' } });
  }
  if (!ctx.siteIds?.has(siteId)) {
    throw new GraphQLError('Access denied to this site', { extensions: { code: 'FORBIDDEN' } });
  }

  return siteId;
}

function requirePositiveId(rawValue, name) {
  const value = Number(rawValue);
  if (!Number.isInteger(value) || value <= 0) {
    throw new GraphQLError(`A valid ${name} is required`, { extensions: { code: 'BAD_USER_INPUT' } });
  }
  return value;
}

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

const ExpenseSortOrderEnum = new GraphQLEnumType({
  name: 'ExpenseSortOrder',
  values: {
    ASC:  { value: 'asc' },
    DESC: { value: 'desc' },
  },
});

const ExpensesPageFiltersInput = new GraphQLInputObjectType({
  name: 'ExpensesPageFiltersInput',
  fields: {
    search:      { type: GraphQLString },
    status:      { type: GraphQLString },
    mode:        { type: GraphQLString },
    category:    { type: GraphQLString },
    // Multi-category filter — each entry is ILIKE-matched against the category column and
    // all conditions are AND'd (e.g. ["PHASE 2", "JCB"] returns rows whose category contains
    // both substrings). Takes precedence over `category` when non-empty.
    categories:  { type: new GraphQLList(new GraphQLNonNull(GraphQLString)) },
    subCategory:   { type: GraphQLString },
    subCategories: { type: new GraphQLList(new GraphQLNonNull(GraphQLString)) },
    toEntity:    { type: GraphQLString },
    dateFrom:    { type: GraphQLString },
    dateTo:      { type: GraphQLString },
    missingBill: { type: GraphQLBoolean },
    // "Money Related To" multi-select: rows linked to ANY of these clients.
    relatedMemberIds: { type: new GraphQLList(new GraphQLNonNull(GraphQLInt)) },
    expenseIds: { type: new GraphQLList(new GraphQLNonNull(GraphQLInt)) },
    vendorPaymentId: { type: GraphQLInt },
    order:       { type: ExpenseSortOrderEnum },
    onlySite:    { type: GraphQLBoolean },
    createdBy:   { type: GraphQLInt },
    entryOrigin: { type: GraphQLString },
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

const ImprestDistributionType = new GraphQLObjectType({
  name: 'ImprestDistribution',
  fields: {
    subAdminId:     { type: new GraphQLNonNull(GraphQLID) },
    recipientName:  { type: new GraphQLNonNull(GraphQLString) },
    totalAmount:    { type: new GraphQLNonNull(GraphQLFloat) },
    allocationCount:{ type: new GraphQLNonNull(GraphQLInt) },
  },
});

const ImprestPairType = new GraphQLObjectType({
  name: 'ImprestPair',
  fields: {
    giverId:         { type: new GraphQLNonNull(GraphQLID) },
    giverName:       { type: new GraphQLNonNull(GraphQLString) },
    giverRole:       { type: new GraphQLNonNull(GraphQLString) },
    receiverId:      { type: new GraphQLNonNull(GraphQLID) },
    receiverName:    { type: new GraphQLNonNull(GraphQLString) },
    receiverRole:    { type: new GraphQLNonNull(GraphQLString) },
    totalAmount:     { type: new GraphQLNonNull(GraphQLFloat) },
    allocationCount: { type: new GraphQLNonNull(GraphQLInt) },
  },
});

const MiscIncomeDetailType = new GraphQLObjectType({
  name: 'MiscIncomeDetail',
  fields: {
    credit: { type: new GraphQLNonNull(GraphQLFloat) },
    debit:  { type: new GraphQLNonNull(GraphQLFloat) },
    net:    { type: new GraphQLNonNull(GraphQLFloat) },
    count:  { type: new GraphQLNonNull(GraphQLInt) },
  },
});

const PlotIncomingType = new GraphQLObjectType({
  name: 'PlotIncoming',
  fields: {
    finalSaleValue:{ type: new GraphQLNonNull(GraphQLFloat) },
    saleValue:     { type: new GraphQLNonNull(GraphQLFloat) },
    received:      { type: new GraphQLNonNull(GraphQLFloat) },
    matchedReceived: { type: new GraphQLNonNull(GraphQLFloat) },
    unmatchedReceived: { type: new GraphQLNonNull(GraphQLFloat) },
    remaining:     { type: new GraphQLNonNull(GraphQLFloat) },
    overpaid:      { type: new GraphQLNonNull(GraphQLFloat) },
    collectionPct: { type: new GraphQLNonNull(GraphQLFloat) },
    plotCount:     { type: new GraphQLNonNull(GraphQLInt) },
  },
});

const LandProfitDetailType = new GraphQLObjectType({
  name: 'LandProfitDetail',
  fields: {
    saleValue:     { type: new GraphQLNonNull(GraphQLFloat) },
    purchaseCost:  { type: new GraphQLNonNull(GraphQLFloat) },
    otherCost:     { type: new GraphQLNonNull(GraphQLFloat) },
    saleProfit:    { type: new GraphQLNonNull(GraphQLFloat) },
    bookProfit:    { type: new GraphQLNonNull(GraphQLFloat) },
    currentProfit: { type: new GraphQLNonNull(GraphQLFloat) },
    received:      { type: new GraphQLNonNull(GraphQLFloat) },
    paidToFarmers: { type: new GraphQLNonNull(GraphQLFloat) },
    remaining:     { type: new GraphQLNonNull(GraphQLFloat) },
    cashReceived:  { type: new GraphQLNonNull(GraphQLFloat) },
    bankReceived:  { type: new GraphQLNonNull(GraphQLFloat) },
    purchaseCostAlreadyExpensed: { type: new GraphQLNonNull(GraphQLFloat) },
    collectionPct: { type: new GraphQLNonNull(GraphQLFloat) },
    marginPct:     { type: new GraphQLNonNull(GraphQLFloat) },
    dealCount:     { type: new GraphQLNonNull(GraphQLInt) },
  },
});

const RegistryPaymentDetailType = new GraphQLObjectType({
  name: 'RegistryPaymentDetail',
  fields: {
    total:    { type: new GraphQLNonNull(GraphQLFloat) },
    cash:     { type: new GraphQLNonNull(GraphQLFloat) },
    bank:     { type: new GraphQLNonNull(GraphQLFloat) },
    newTotal: { type: new GraphQLNonNull(GraphQLFloat) },
    oldTotal: { type: new GraphQLNonNull(GraphQLFloat) },
    newCash:  { type: new GraphQLNonNull(GraphQLFloat) },
    newBank:  { type: new GraphQLNonNull(GraphQLFloat) },
    oldCash:  { type: new GraphQLNonNull(GraphQLFloat) },
    oldBank:  { type: new GraphQLNonNull(GraphQLFloat) },
    count:    { type: new GraphQLNonNull(GraphQLInt) },
    newCount: { type: new GraphQLNonNull(GraphQLInt) },
    oldCount: { type: new GraphQLNonNull(GraphQLInt) },
  },
});

const TdsSummaryType = new GraphQLObjectType({
  name: 'TdsSummary',
  fields: {
    deducted: { type: GraphQLFloat }, deposited: { type: GraphQLFloat },
    payable: { type: GraphQLFloat }, with_ca: { type: GraphQLFloat },
    reserve: { type: GraphQLFloat }, overdue: { type: GraphQLFloat },
    pending: { type: GraphQLFloat }, legacy_deposited: { type: GraphQLFloat },
    as_of: { type: GraphQLString },
  },
});

const SiteBalanceDetailType = new GraphQLObjectType({
  name: 'SiteBalanceDetail',
  fields: {
    totalMoneyIn:         { type: new GraphQLNonNull(GraphQLFloat) },
    totalMoneyOut:        { type: new GraphQLNonNull(GraphQLFloat) },
    cashBalance:          { type: new GraphQLNonNull(GraphQLFloat) },
    bankBalance:          { type: new GraphQLNonNull(GraphQLFloat) },
    balanceBeforeImprest: { type: new GraphQLNonNull(GraphQLFloat) },
    imprestHeld:          { type: new GraphQLNonNull(GraphQLFloat) },
    adminImprestReserved: { type: new GraphQLNonNull(GraphQLFloat) },
    pendingImprestReservations: { type: new GraphQLNonNull(GraphQLFloat) },
    distributableBalance: { type: new GraphQLNonNull(GraphQLFloat) },
    siteBalance:          { type: new GraphQLNonNull(GraphQLFloat) },
    periodMoneyIn:        { type: new GraphQLNonNull(GraphQLFloat) },
    periodMoneyOut:       { type: new GraphQLNonNull(GraphQLFloat) },
    periodNet:            { type: new GraphQLNonNull(GraphQLFloat) },
    tdsPayable: { type: GraphQLFloat },
    tdsWithCa: { type: GraphQLFloat },
    tdsReserve: { type: GraphQLFloat },
    availableBalance: { type: GraphQLFloat },
  },
});

const KpiCardsType = new GraphQLObjectType({
  name: 'KpiCards',
  fields: {
    // Authoritative Site Balance — ledger net minus imprest float. Same value
    // the Day Book and Balance Sheet show; the dashboard renders this instead
    // of re-deriving it from revenue/expense/outstanding components.
    siteBalance:           { type: new GraphQLNonNull(GraphQLFloat) },
    siteBalanceDetail:     { type: new GraphQLNonNull(SiteBalanceDetailType) },
    tds:                   { type: TdsSummaryType },
    plotIncoming:          { type: new GraphQLNonNull(PlotIncomingType) },
    landProfitDetail:      { type: new GraphQLNonNull(LandProfitDetailType) },
    registryPaymentDetail: { type: new GraphQLNonNull(RegistryPaymentDetailType) },
    runningExpense:        { type: new GraphQLNonNull(GraphQLFloat) },
    partnerProfitPaid:     { type: new GraphQLNonNull(GraphQLFloat) },
    expectedProfit:        { type: new GraphQLNonNull(GraphQLFloat) },
    currentProfit:         { type: new GraphQLNonNull(GraphQLFloat) },
    totalRevenue:          { type: new GraphQLNonNull(GraphQLFloat) },
    totalExpense:          { type: new GraphQLNonNull(GraphQLFloat) },
    netProfit:             { type: new GraphQLNonNull(GraphQLFloat) },
    profitMargin:          { type: new GraphQLNonNull(GraphQLFloat) },
    currentProfitMargin:   { type: new GraphQLNonNull(GraphQLFloat) },
    outstanding:           { type: new GraphQLNonNull(GraphQLFloat) },
    cashflow:              { type: new GraphQLNonNull(GraphQLFloat) },
    personalLedgerCredit:  { type: new GraphQLNonNull(GraphQLFloat) },
    // Nullable on purpose: KPI payloads cached before this field existed must not error.
    miscIncome:            { type: GraphQLFloat },
    miscIncomeDetail:      { type: MiscIncomeDetailType },
    imprestGiven:          { type: new GraphQLNonNull(GraphQLFloat) },
    registryPayments:      { type: new GraphQLNonNull(GraphQLFloat) },
    registryPaymentsCount: { type: new GraphQLNonNull(GraphQLInt) },
    registryPaymentsNew:      { type: GraphQLFloat },
    registryPaymentsOld:      { type: GraphQLFloat },
    registryPaymentsNewCount: { type: GraphQLInt },
    registryPaymentsOldCount: { type: GraphQLInt },
    // Registry Value RO (manual rounded receipts) — nullable so cached payloads predating them never error.
    registryRoTotal:          { type: GraphQLFloat },
    registryRoCash:           { type: GraphQLFloat },
    registryRoBank:           { type: GraphQLFloat },
    registryRoCount:          { type: GraphQLInt },
    registryRoDiff:           { type: GraphQLFloat },
    registryRoExact:          { type: GraphQLFloat },
    imprestDistribution:   { type: new GraphQLList(ImprestDistributionType) },
    imprestPairs:          { type: new GraphQLList(ImprestPairType) },
    breakdown:             { type: new GraphQLList(BreakdownItemType) },
    cashflowDetail:        { type: CashflowDetailType },
    outstandingDetail:     { type: OutstandingDetailType },
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

const ExpensePageSummaryType = new GraphQLObjectType({
  name: 'ExpensePageSummary',
  fields: {
    total_debit:  { type: GraphQLFloat },
    total_credit: { type: GraphQLFloat },
    total_count:  { type: GraphQLInt },
    cash_debit:   { type: GraphQLFloat },
    cash_credit:  { type: GraphQLFloat },
    bank_debit:   { type: GraphQLFloat },
    bank_credit:  { type: GraphQLFloat },
  },
});

const ExpensePagePaginationType = new GraphQLObjectType({
  name: 'ExpensePagePagination',
  fields: {
    totalItems:  { type: new GraphQLNonNull(GraphQLInt) },
    totalPages:  { type: new GraphQLNonNull(GraphQLInt) },
    currentPage: { type: new GraphQLNonNull(GraphQLInt) },
    itemsPerPage:{ type: new GraphQLNonNull(GraphQLInt) },
  },
});

const ExpenseModeBreakdownType = new GraphQLObjectType({
  name: 'ExpenseModeBreakdown',
  fields: {
    payment_mode: { type: GraphQLString },
    total_debit:  { type: GraphQLFloat },
    total_credit: { type: GraphQLFloat },
    entries:      { type: GraphQLInt },
  },
});

const ExpenseCategoryBreakdownType = new GraphQLObjectType({
  name: 'ExpenseCategoryBreakdown',
  fields: {
    category:     { type: GraphQLString },
    total_debit:  { type: GraphQLFloat },
    total_credit: { type: GraphQLFloat },
    entries:      { type: GraphQLInt },
  },
});

const ExpenseRelatedPartyType = new GraphQLObjectType({
  name: 'ExpenseRelatedParty',
  fields: {
    member_id: { type: new GraphQLNonNull(GraphQLInt) },
    name: { type: GraphQLString },
    phone: { type: GraphQLString },
    direction: { type: GraphQLString },
  },
});

const ExpenseEntryType = new GraphQLObjectType({
  name: 'ExpenseEntry',
  fields: {
    id:                { type: new GraphQLNonNull(GraphQLID) },
    original_id:       { type: GraphQLInt },
    site_id:           { type: GraphQLInt },
    date:              { type: GraphQLString },
    from_entity:       { type: GraphQLString },
    to_entity:         { type: GraphQLString },
    payment_mode:      { type: GraphQLString },
    debit:             { type: GraphQLFloat },
    credit:            { type: GraphQLFloat },
    balance:           { type: GraphQLFloat },
    remark:            { type: GraphQLString },
    account_no:        { type: GraphQLString },
    branch:            { type: GraphQLString },
    category:          { type: GraphQLString },
    sub_category:      { type: GraphQLString },
    status:            { type: GraphQLString },
    approved_by:       { type: GraphQLInt },
    approved_at:       { type: GraphQLString },
    approved_by_name:  { type: GraphQLString },
    created_by:        { type: GraphQLInt },
    created_by_name:   { type: GraphQLString },
    related_party:     { type: ExpenseRelatedPartyType },
    created_at:        { type: GraphQLString },
    updated_at:        { type: GraphQLString },
    assigned_user_id:  { type: GraphQLInt },
    assigned_user_name:{ type: GraphQLString },
    assigned_admin_id: { type: GraphQLInt },
    assigned_admin_name:{ type: GraphQLString },
    voucher_url:       { type: GraphQLString },
    voucher_urls:      { type: new GraphQLList(GraphQLString) },
    bill_url:          { type: GraphQLString },
    bill_urls:         { type: new GraphQLList(GraphQLString) },
    customer_signature_url: { type: GraphQLString },
    authority_signature_url: { type: GraphQLString },
    source:            { type: GraphQLString },
    commitment_id:     { type: GraphQLInt },
    project_id:        { type: GraphQLInt },
    project_name:      { type: GraphQLString },
    vendor_name:       { type: GraphQLString },
    work_title:        { type: GraphQLString },
    posted_debit:      { type: GraphQLString },
    posted_credit:     { type: GraphQLString },
    ledger_id:         { type: GraphQLString },
    cheque_no:         { type: GraphQLString },
    cheque_status:     { type: GraphQLString },
    cheque_apply_date: { type: GraphQLString },
    cheque_transaction_date: { type: GraphQLString },
    cheque_source_module: { type: GraphQLString },
    cheque_source_id: { type: GraphQLInt },
    entry_transfer_id: { type: GraphQLString },
    entry_transfer_role: { type: GraphQLString },
    verifyUrl:         { type: GraphQLString },
  },
});

const ExpensesPageDataType = new GraphQLObjectType({
  name: 'ExpensesPageData',
  fields: {
    expenses:          { type: new GraphQLList(ExpenseEntryType) },
    summary:           { type: ExpensePageSummaryType },
    pagination:        { type: ExpensePagePaginationType },
    modeBreakdown:     { type: new GraphQLList(ExpenseModeBreakdownType) },
    categoryBreakdown: { type: new GraphQLList(ExpenseCategoryBreakdownType) },
  },
});

const ExpensesBreakdownType = new GraphQLObjectType({
  name: 'ExpensesBreakdown',
  fields: {
    modeBreakdown:     { type: new GraphQLList(ExpenseModeBreakdownType) },
    categoryBreakdown: { type: new GraphQLList(ExpenseCategoryBreakdownType) },
  },
});

// ── Plot Payment Types ──

const PlotMemberType = new GraphQLObjectType({
  name: 'PlotMember',
  fields: {
    id:         { type: GraphQLInt },
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

const ProjectUnitDetailsType = new GraphQLObjectType({
  name: 'ProjectUnitDetails',
  fields: {
    tower: { type: GraphQLString },
    floor: { type: GraphQLString },
    bedrooms: { type: GraphQLString },
    parking: { type: GraphQLString },
    facing: { type: GraphQLString },
    khasra_no: { type: GraphQLString },
    approval_reference: { type: GraphQLString },
    allotment_no: { type: GraphQLString },
    agreement_date: { type: GraphQLString },
    possession_date: { type: GraphQLString },
    area_basis: { type: GraphQLString },
    carpet_area: { type: GraphQLFloat },
    built_up_area: { type: GraphQLFloat },
    super_built_up_area: { type: GraphQLFloat },
    balcony_area: { type: GraphQLFloat },
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
    unit_type:           { type: GraphQLString },
    unit_details:        { type: ProjectUnitDetailsType },
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
    scheme:              { type: GraphQLString },
    approval_status:     { type: GraphQLString },
    plot_tag:            { type: GraphQLString },
    // Co-applicant — one home on the plot row, shared by booking → plot → NOC → registry.
    co_applicant_name:     { type: GraphQLString },
    co_applicant_relation: { type: GraphQLString },
    co_applicant_phone:    { type: GraphQLString },
    co_applicant_aadhar:   { type: GraphQLString },
    co_applicant_pan:      { type: GraphQLString },
    nominee_name:         { type: GraphQLString },
    nominee_relation:     { type: GraphQLString },
    nominee_phone:        { type: GraphQLString },
    team:                { type: GraphQLString },
    plot_commission:     { type: GraphQLFloat },
    commission_enabled:  { type: GraphQLBoolean },
    commission_type:     { type: GraphQLString },
    commission_value:    { type: GraphQLFloat },
    commission_rate:     { type: GraphQLFloat },
    original_plot_rate:  { type: GraphQLFloat },
    discount_rate:       { type: GraphQLFloat },
    discount_amount:     { type: GraphQLFloat },
    plc_charges:         { type: GraphQLFloat },
    installments_enabled: { type: GraphQLBoolean },
    full_payment_due:    { type: GraphQLBoolean },
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
    has_registry:          { type: GraphQLBoolean },
    registry_bank_received: { type: GraphQLFloat },
    received_cash:         { type: GraphQLFloat },
    payment_count:         { type: GraphQLInt },
    payment_buyer_names:   { type: GraphQLString },
    payment_booked_bys:    { type: GraphQLString },
    buyer_member_id:       { type: GraphQLInt },
    buyer_kyc_status:      { type: GraphQLString },
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
    customer_signature_url:  { type: GraphQLString },
    authority_signature_url: { type: GraphQLString },
    assigned_admin_id: { type: GraphQLInt },
    buyer_name:        { type: GraphQLString },
    booked_by:         { type: GraphQLString },
    received_by:       { type: GraphQLString },
    cheque_no:         { type: GraphQLString },
    cheque_status:     { type: GraphQLString },
    cheque_apply_date: { type: GraphQLString },
    cheque_transaction_date: { type: GraphQLString },
    cheque_source_module: { type: GraphQLString },
    cheque_source_id: { type: GraphQLInt },
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
const CACHE_TTL = 15; // 15 seconds — short enough to stay fresh while reducing DB load

function cacheKey(prefix, siteId, start, end) {
  return `dashboard:${prefix}:${siteId}:${start}:${end}`;
}

function readChart(siteId, range, resolution, excludeOldPlots) {
  const key = cacheKey(`chart-rve-${resolution}${excludeOldPlots ? '-new' : ''}`, siteId, range.start, range.end);
  return readDashboardCache(key, () => getRevenueVsExpense(siteId, range.start, range.end, resolution, excludeOldPlots));
}

// Keeps only real positive ids, sorted and de-duplicated so the cache key for
// [3, 1] and [1, 3, 3] is the same entry.
const positiveIntList = (values) => {
  const ids = [...new Set((values || []).map(Number).filter((n) => Number.isInteger(n) && n > 0))].sort((a, b) => a - b);
  return ids.length ? ids : undefined;
};

function serializeFilters(filters = {}) {
  return Object.entries(filters)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}:${String(value)}`)
    .join('|') || 'none';
}

function expensesCacheKey(userId, siteId, page, limit, filters) {
  return `expenses:page:${userId}:${siteId}:${page}:${limit}:${filters}`;
}

// ── Root Query ──

// ── Construction + Inventory dashboard cards ──
const ConstructionDashboardType = new GraphQLObjectType({
  name: 'ConstructionDashboard',
  fields: {
    activeProjects:          { type: GraphQLInt },
    delayedProjects:         { type: GraphQLInt },
    avgProgress:             { type: GraphQLInt },
    pendingMaterialRequests: { type: GraphQLInt },
    totalBudget:             { type: GraphQLFloat },
    totalActualCost:         { type: GraphQLFloat },
  },
});
const InventoryDashboardType = new GraphQLObjectType({
  name: 'InventoryDashboard',
  fields: {
    materialCount:           { type: GraphQLInt },
    totalValue:              { type: GraphQLFloat },
    lowStockCount:           { type: GraphQLInt },
    pendingVendorDeliveries: { type: GraphQLInt },
  },
});

// ── Finance Forecast module ──
const ForecastHistoricalType = new GraphQLObjectType({
  name: 'ForecastHistoricalMonth',
  fields: {
    key:          { type: GraphQLString },
    label:        { type: GraphQLString },
    inflow:       { type: GraphQLFloat },
    outflow:      { type: GraphQLFloat },
    net:          { type: GraphQLFloat },
    transactions: { type: GraphQLInt },
    isCurrent:    { type: GraphQLBoolean },
  },
});

const ForecastMonthType = new GraphQLObjectType({
  name: 'ForecastMonth',
  fields: {
    key:                        { type: GraphQLString },
    label:                      { type: GraphQLString },
    predictedInflow:            { type: GraphQLFloat },
    predictedOutflow:           { type: GraphQLFloat },
    scheduledInflow:            { type: GraphQLFloat },
    scheduledOutflow:           { type: GraphQLFloat },
    inflow:                      { type: GraphQLFloat },
    outflow:                     { type: GraphQLFloat },
    net:                         { type: GraphQLFloat },
    conservativeInflow:          { type: GraphQLFloat },
    conservativeOutflow:         { type: GraphQLFloat },
    conservativeNet:             { type: GraphQLFloat },
    optimisticInflow:            { type: GraphQLFloat },
    optimisticOutflow:           { type: GraphQLFloat },
    optimisticNet:               { type: GraphQLFloat },
    lowerNet:                    { type: GraphQLFloat },
    upperNet:                    { type: GraphQLFloat },
    baseClosingBalance:          { type: GraphQLFloat },
    conservativeClosingBalance:  { type: GraphQLFloat },
    optimisticClosingBalance:    { type: GraphQLFloat },
  },
});

const ForecastTotalsType = new GraphQLObjectType({
  name: 'ForecastTotals',
  fields: {
    inflow:  { type: GraphQLFloat },
    outflow: { type: GraphQLFloat },
    net:     { type: GraphQLFloat },
  },
});

const ForecastScenarioTotalsType = new GraphQLObjectType({
  name: 'ForecastScenarioTotals',
  fields: {
    base:         { type: ForecastTotalsType },
    conservative: { type: ForecastTotalsType },
    optimistic:   { type: ForecastTotalsType },
  },
});

const ForecastRunRateType = new GraphQLObjectType({
  name: 'ForecastRunRate',
  fields: {
    lookbackMonths:   { type: GraphQLInt },
    inflowPerMonth:   { type: GraphQLFloat },
    outflowPerMonth:  { type: GraphQLFloat },
  },
});

const ForecastAnalyticsType = new GraphQLObjectType({
  name: 'ForecastAnalytics',
  fields: {
    method:                { type: GraphQLString },
    version:               { type: GraphQLString },
    confidenceScore:       { type: GraphQLInt },
    confidenceLevel:       { type: GraphQLString },
    historicalMonths:      { type: GraphQLInt },
    activeMonths:          { type: GraphQLInt },
    transactionCount:      { type: GraphQLInt },
    inflowTrendPercent:    { type: GraphQLFloat },
    outflowTrendPercent:   { type: GraphQLFloat },
    inflowTrend:           { type: GraphQLString },
    outflowTrend:          { type: GraphQLString },
    inflowVolatility:      { type: GraphQLFloat },
    outflowVolatility:     { type: GraphQLFloat },
  },
});

const ForecastContextType = new GraphQLObjectType({
  name: 'ForecastContext',
  fields: {
    overdueReceivables: { type: GraphQLFloat },
    vendorOverdue:      { type: GraphQLFloat },
    vendorUnscheduled:  { type: GraphQLFloat },
    farmerOutstanding:  { type: GraphQLFloat },
  },
});

const ForecastRiskType = new GraphQLObjectType({
  name: 'ForecastRisk',
  fields: {
    level:                     { type: GraphQLString },
    summary:                   { type: GraphQLString },
    lowestBalance:             { type: GraphQLFloat },
    lowestConservativeBalance: { type: GraphQLFloat },
    deficitMonths:             { type: GraphQLInt },
    firstDeficitMonth:         { type: GraphQLString },
  },
});

const ForecastWeekdayType = new GraphQLObjectType({
  name: 'ForecastWeekdayPattern',
  fields: {
    weekday:      { type: GraphQLInt },
    label:        { type: GraphQLString },
    inflow:       { type: GraphQLFloat },
    outflow:      { type: GraphQLFloat },
    transactions: { type: GraphQLInt },
  },
});

const ForecastSourceType = new GraphQLObjectType({
  name: 'ForecastSourcePattern',
  fields: {
    source:       { type: GraphQLString },
    label:        { type: GraphQLString },
    inflow:       { type: GraphQLFloat },
    outflow:      { type: GraphQLFloat },
    transactions: { type: GraphQLInt },
  },
});

const ForecastDueItemType = new GraphQLObjectType({
  name: 'ForecastDueItem',
  fields: {
    id:          { type: GraphQLID },
    type:        { type: GraphQLString },
    source:      { type: GraphQLString },
    entity:      { type: GraphQLString },
    description: { type: GraphQLString },
    dueDate:     { type: GraphQLString },
    amount:      { type: GraphQLFloat },
    status:      { type: GraphQLString },
  },
});

const FinanceForecastType = new GraphQLObjectType({
  name: 'FinanceForecast',
  fields: {
    currentBalance:      { type: GraphQLFloat },
    historical:          { type: new GraphQLList(ForecastHistoricalType) },
    forecast:            { type: new GraphQLList(ForecastMonthType) },
    totals:              { type: ForecastScenarioTotalsType },
    runRate:             { type: ForecastRunRateType },
    analytics:           { type: ForecastAnalyticsType },
    context:             { type: ForecastContextType },
    risk:                { type: ForecastRiskType },
    weekdayPattern:      { type: new GraphQLList(ForecastWeekdayType) },
    sourcePattern:       { type: new GraphQLList(ForecastSourceType) },
    dueItems:            { type: new GraphQLList(ForecastDueItemType) },
    horizonMonths:       { type: GraphQLInt },
    generatedAt:         { type: GraphQLString },
    refreshAfterSeconds: { type: GraphQLInt },
  },
});

const ProfitPortfolioShareType = new GraphQLObjectType({
  name: 'ProfitPortfolioShare',
  fields: {
    id: { type: GraphQLID }, member_id: { type: GraphQLID }, farmer_id: { type: GraphQLID },
    share_pct: { type: GraphQLFloat }, notes: { type: GraphQLString }, full_name: { type: GraphQLString },
    member_type: { type: GraphQLString }, phone: { type: GraphQLString }, photo: { type: GraphQLString },
  },
});
const ProfitPortfolioSideType = new GraphQLObjectType({
  name: 'ProfitPortfolioSide',
  fields: { expectedProfit: { type: GraphQLFloat }, currentProfit: { type: GraphQLFloat } },
});
const ProfitPortfolioProfitType = new GraphQLObjectType({
  name: 'ProfitPortfolioProfit',
  fields: {
    expectedProfit: { type: GraphQLFloat }, currentProfit: { type: GraphQLFloat }, runningExpense: { type: GraphQLFloat },
    siteBalance: { type: GraphQLFloat }, siteBalanceDetail: { type: SiteBalanceDetailType },
    plotIncoming: { type: PlotIncomingType }, landProfitDetail: { type: LandProfitDetailType },
    plot: { type: ProfitPortfolioSideType }, land: { type: ProfitPortfolioSideType },
  },
});
const ProfitPortfolioLandType = new GraphQLObjectType({
  name: 'ProfitPortfolioLand',
  fields: {
    farmer_id: { type: GraphQLID }, name: { type: GraphQLString }, saleValue: { type: GraphQLFloat },
    soldCost: { type: GraphQLFloat }, otherCost: { type: GraphQLFloat }, bookProfit: { type: GraphQLFloat },
    received: { type: GraphQLFloat }, paid: { type: GraphQLFloat }, expectedProfit: { type: GraphQLFloat },
    currentProfit: { type: GraphQLFloat }, shares: { type: new GraphQLList(ProfitPortfolioShareType) },
  },
});
const ProfitPortfolioPaidType = new GraphQLObjectType({
  name: 'ProfitPortfolioPaid',
  fields: {
    member_id: { type: GraphQLID }, full_name: { type: GraphQLString }, phone: { type: GraphQLString }, photo: { type: GraphQLString },
    paid: { type: GraphQLFloat }, payment_count: { type: GraphQLInt },
  },
});
const ProfitPortfolioLedgerType = new GraphQLObjectType({
  name: 'ProfitPortfolioLedger',
  fields: {
    id: { type: GraphQLID }, site_id: { type: GraphQLID }, ledger_type: { type: GraphQLString }, ledger_name: { type: GraphQLString },
    linked_member_id: { type: GraphQLID }, is_locked: { type: GraphQLBoolean }, opening_balance: { type: GraphQLFloat }, total_debit: { type: GraphQLFloat },
    total_credit: { type: GraphQLFloat }, entry_count: { type: GraphQLInt }, month: { type: GraphQLInt }, year: { type: GraphQLInt },
    profit_given_debit: { type: GraphQLFloat }, profit_return_credit: { type: GraphQLFloat },
  },
});
const ProfitPortfolioPaymentType = new GraphQLObjectType({
  name: 'ProfitPortfolioPayment',
  fields: {
    id: { type: GraphQLID }, site_id: { type: GraphQLID }, member_id: { type: GraphQLID },
    full_name: { type: GraphQLString }, phone: { type: GraphQLString }, photo: { type: GraphQLString },
    date: { type: GraphQLString }, transaction_time: { type: GraphQLString }, amount: { type: GraphQLFloat },
    posted_amount: { type: GraphQLFloat }, tds_amount: { type: GraphQLFloat }, status: { type: GraphQLString },
    entry_transfer_id: { type: GraphQLID }, payment_mode: { type: GraphQLString }, bank_name: { type: GraphQLString },
    bank_reference: { type: GraphQLString }, remarks: { type: GraphQLString }, bank_account_id: { type: GraphQLID },
    created_by_name: { type: GraphQLString }, voucher_url: { type: GraphQLString }, tds_rate: { type: GraphQLFloat },
    tds_mode: { type: GraphQLString }, tds_section: { type: GraphQLString }, tds_module: { type: GraphQLString },
    tds_member_id: { type: GraphQLID }, tds_deductee_name: { type: GraphQLString }, tds_pan: { type: GraphQLString },
    tds_aadhaar: { type: GraphQLString },
  },
});
const ProfitPortfolioSiteType = new GraphQLObjectType({
  name: 'ProfitPortfolioSite',
  fields: {
    siteId: { type: new GraphQLNonNull(GraphQLID) }, siteName: { type: new GraphQLNonNull(GraphQLString) },
    profit: { type: ProfitPortfolioProfitType }, shares: { type: new GraphQLList(ProfitPortfolioShareType) },
    lands: { type: new GraphQLList(ProfitPortfolioLandType) }, payments: { type: new GraphQLList(ProfitPortfolioPaidType) },
    personalLedgers: { type: new GraphQLList(ProfitPortfolioLedgerType) }, profitPayments: { type: new GraphQLList(ProfitPortfolioPaymentType) },
    personalLedgersUnavailable: { type: GraphQLBoolean }, profitPaymentsUnavailable: { type: GraphQLBoolean },
  },
});
const ProfitPortfolioFailureType = new GraphQLObjectType({
  name: 'ProfitPortfolioFailure',
  fields: { id: { type: GraphQLID }, name: { type: GraphQLString }, message: { type: GraphQLString }, scopeChanged: { type: GraphQLBoolean } },
});
const ProfitPortfolioType = new GraphQLObjectType({
  name: 'ProfitPortfolio',
  fields: {
    data: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(ProfitPortfolioSiteType))) },
    failures: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(ProfitPortfolioFailureType))) },
    completed: { type: new GraphQLNonNull(GraphQLInt) }, total: { type: new GraphQLNonNull(GraphQLInt) },
    generatedAt: { type: GraphQLString }, refreshing: { type: GraphQLBoolean }, cacheStatus: { type: GraphQLString },
  },
});

const QueryType = new GraphQLObjectType({
  name: 'Query',
  fields: {
    ...walletImprestQueryFields,
    profitPortfolio: {
      type: ProfitPortfolioType,
      args: {
        siteIds: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(GraphQLID))) },
        excludeOldPlots: { type: GraphQLBoolean }, refresh: { type: GraphQLBoolean }, overall: { type: GraphQLBoolean },
      },
      async resolve(_, { siteIds, excludeOldPlots = false, refresh = false, overall = false }, ctx) {
        if (!ctx?.user) throw new GraphQLError('Authentication required', { extensions: { code: 'UNAUTHENTICATED' } });
        if (!PRIVILEGED_ROLES.has(ctx.user.role)) throw new GraphQLError('Administrator access is required for the profit portfolio', { extensions: { code: 'FORBIDDEN' } });
        const ids = [...new Set(siteIds.map(id => requirePositiveId(id, 'siteId')))].sort((a, b) => a - b);
        if (ids.length > 1000) throw new GraphQLError('Too many sites requested', { extensions: { code: 'BAD_USER_INPUT' } });
        // Authoritative metadata is deliberately read before any snapshot. A
        // switched-off overall site must not survive an old cached portfolio.
        const { rows: sites } = ids.length ? await pool.query('SELECT id, name, include_in_overall FROM sites WHERE id = ANY($1::int[])', [ids]) : { rows: [] };
        const names = new Map(sites.map(site => [Number(site.id), site.name]));
        const allowedIds = sites.filter(site => !overall || site.include_in_overall !== false).map(site => Number(site.id)).sort((a, b) => a - b);
        const allowed = new Set(allowedIds);
        const scopeFailures = ids.filter(id => !allowed.has(id)).map(id => ({ id, name: names.get(id) || `Site ${id}`, scopeChanged: true,
          message: names.has(id) ? 'This site is excluded from overall reports.' : 'This site is no longer available.' }));
        const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
        const date = new Date(`${today}T00:00:00Z`); date.setUTCDate(date.getUTCDate() + 1);
        const end = date.toISOString().slice(0, 10);
        const snapshot = await getProfitPortfolioSnapshot({ userId: ctx.user.id, siteIds: allowedIds, end, excludeOldPlots, refresh },
          () => buildProfitPortfolio(allowedIds, end, excludeOldPlots));
        return { ...snapshot.value,
          data: snapshot.value.data.map(site => ({ ...site, siteName: names.get(Number(site.siteId)) || site.siteName })),
          failures: [...scopeFailures, ...snapshot.value.failures.map(site => ({ ...site, name: names.get(Number(site.id)) || site.name }))],
          completed: ids.length, total: ids.length, generatedAt: snapshot.generatedAt,
          refreshing: snapshot.refreshing, cacheStatus: snapshot.cacheStatus };
      },
    },
    financeForecast: {
      type: FinanceForecastType,
      args: {
        siteId:         { type: new GraphQLNonNull(GraphQLID) },
        horizonMonths:  { type: GraphQLInt },
        lookbackMonths: { type: GraphQLInt },
        forceRefresh:   { type: GraphQLBoolean },
      },
      async resolve(_, { siteId, horizonMonths = 6, lookbackMonths = 12, forceRefresh = false }, ctx) {
        const id = requireModuleRead(ctx, 'finance_forecast', siteId);
        const horizon = Math.min(Math.max(Number(horizonMonths) || 6, 1), 18);
        const lookback = Math.min(Math.max(Number(lookbackMonths) || 12, 3), 24);
        const key = `finance-forecast:${id}:${horizon}:${lookback}`;

        if (!forceRefresh && cacheEnabled()) {
          const cached = await cacheGet(key);
          if (cached) return cached;
        }

        const result = await getFinanceForecast(id, {
          horizonMonths: horizon,
          lookbackMonths: lookback,
        });
        // A 55-second server cache keeps minute polling fast while ensuring
        // every scheduled poll can observe a fresh financial snapshot.
        if (cacheEnabled()) await cacheSet(key, result, 55);
        return result;
      },
    },

    constructionDashboard: {
      type: ConstructionDashboardType,
      args: { siteId: { type: new GraphQLNonNull(GraphQLID) } },
      async resolve(_, { siteId }, ctx) {
        const id = requireModuleRead(ctx, 'construction', siteId);
        const { summary } = await getConstructionSummaryData({ siteId: id, user: ctx.user });
        return {
          activeProjects: summary.active_projects,
          delayedProjects: summary.delayed_projects,
          avgProgress: summary.avg_progress,
          pendingMaterialRequests: summary.pending_material_requests,
          totalBudget: Number(summary.total_budget) || 0,
          // Operational material consumption valuation, separate from posted cash.
          totalActualCost: Number(summary.total_actual_cost) || 0,
        };
      },
    },
    inventoryDashboard: {
      type: InventoryDashboardType,
      args: { siteId: { type: new GraphQLNonNull(GraphQLID) } },
      async resolve(_, { siteId }, ctx) {
        const id = requireModuleRead(ctx, 'inventory', siteId);
        const [s, deliv] = await Promise.all([
          inventoryModel.summary(id),
          pool.query(`SELECT COUNT(*)::int AS c FROM vendor_inventory_orders WHERE site_id = $1 AND status IN ('open','partial')`, [id]),
        ]);
        return {
          materialCount: s.material_count,
          totalValue: parseFloat(s.total_value) || 0,
          lowStockCount: s.low_stock_count,
          pendingVendorDeliveries: deliv.rows[0].c,
        };
      },
    },
    kpiCards: {
      type: KpiCardsType,
      args: {
        siteId: { type: new GraphQLNonNull(GraphQLID) },
        range:  { type: new GraphQLNonNull(DateRangeInput) },
        excludeOldPlots: { type: GraphQLBoolean },
      },
      async resolve(_, { siteId, range, excludeOldPlots = false }, ctx, info) {
        const id = requireModuleRead(ctx, 'dashboard', siteId);
        const fields = selectedFields(info);
        // Partial reports must not share a key with a different selection.
        const selection = [...fields].sort().join(',');
        const key = cacheKey(`kpi-cards-v9${excludeOldPlots ? '-new' : ''}:${selection}`, id, range.start, range.end);
        return readDashboardCache(key, async () => {
          const result = await getAllKpis(id, range.start, range.end, excludeOldPlots, fields);
          const toArray = breakdown => Object.entries(breakdown).map(([module, value]) => ({
            module, debit: value.debit || 0, credit: value.credit || 0, count: value.count || 0,
          }));
          return { ...result, breakdown: toArray(result.breakdown) };
        });
      },
    },

    verifyFinancialIntegrity: {
      type: VerificationType,
      args: {
        siteId: { type: new GraphQLNonNull(GraphQLID) },
        range:  { type: new GraphQLNonNull(DateRangeInput) },
      },
      async resolve(_, { siteId, range }, ctx) {
        const id = requireModuleRead(ctx, 'dashboard', siteId);
        const result = await verifyFinancialIntegrity(id, range.start, range.end);
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
        const id = requireModuleRead(ctx, 'dashboard', siteId);
        return readChart(id, range, resolution, excludeOldPlots);
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
        const id = requireModuleRead(ctx, 'dashboard', siteId);
        const data = await readChart(id, range, resolution, excludeOldPlots);
        return data.map(row => ({ date: row.date, label: row.label, value: row.revenue - row.expense }));
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
        const id = requireModuleRead(ctx, 'dashboard', siteId);
        const data = await getExpenseByCategory(id, range.start, range.end, top);
        return data;
      },
    },

    expensesPageData: {
      type: ExpensesPageDataType,
      args: {
        siteId: { type: new GraphQLNonNull(GraphQLID) },
        page:   { type: GraphQLInt },
        limit:  { type: GraphQLInt },
        filters:{ type: ExpensesPageFiltersInput },
        includeBreakdowns: { type: GraphQLBoolean },
      },
      async resolve(_, { siteId, page = 1, limit = 20, filters = {}, includeBreakdowns = false }, ctx) {
        const id = requireModuleRead(ctx, 'expenses', siteId);
        const safePage = Number.isFinite(page) ? Math.max(1, page) : 1;
        const safeLimit = Number.isFinite(limit) ? Math.max(0, limit) : 20;
        const canViewAllEntries = PRIVILEGED_ROLES.has(ctx.user.role)
          || ctx.permissions?.get('expenses')?.can_view_all === true;
        const requestedCreator = Number(filters.createdBy);
        const normalizedFilters = {
          search: filters.search || undefined,
          status: filters.status || undefined,
          mode: filters.mode || undefined,
          category: filters.category || undefined,
          categories: Array.isArray(filters.categories) && filters.categories.length > 0
            ? filters.categories.map((c) => String(c).trim()).filter(Boolean)
            : undefined,
          sub_category: filters.subCategory || undefined,
          sub_categories: Array.isArray(filters.subCategories) && filters.subCategories.length > 0
            ? filters.subCategories.map((c) => String(c).trim()).filter(Boolean)
            : undefined,
          to_entity: filters.toEntity || undefined,
          dateFrom: filters.dateFrom || undefined,
          dateTo: filters.dateTo || undefined,
          missing_bill: filters.missingBill ? 'true' : undefined,
          related_member_ids: positiveIntList(filters.relatedMemberIds),
          expense_ids: Array.isArray(filters.expenseIds) ? positiveIntList(filters.expenseIds) || [] : undefined,
          vendor_payment_id: filters.vendorPaymentId ? requirePositiveId(filters.vendorPaymentId,'vendorPaymentId') : undefined,
          ...await constructionExpenseScope(ctx.user),
          entry_origin: ['original', 'transfer'].includes(filters.entryOrigin) ? filters.entryOrigin : undefined,
          order: filters.order || 'desc',
          // Ordinary expenses and authorized linked vendor payments share one register.
          only_site: filters.onlySite === false ? undefined : 'true',
          created_by: canViewAllEntries
            ? (Number.isInteger(requestedCreator) && requestedCreator > 0 ? requestedCreator : undefined)
            : Number(ctx.user.id),
        };

        const key = expensesCacheKey(
          ctx.user.id || 'anon',
          id,
          safePage,
          safeLimit,
          serializeFilters(normalizedFilters),
        ) + `:br=${includeBreakdowns ? 1 : 0}`;

        if (cacheEnabled() && !normalizedFilters.include_vendor) {
          const cached = await cacheGet(key);
          if (cached) return cached;
        }

        const data = await getExpensesPageData(id, {
          filters: normalizedFilters,
          page: safePage,
          limit: safeLimit,
          includeBreakdowns,
        });

        if (cacheEnabled() && !normalizedFilters.include_vendor) await cacheSet(key, data, CACHE_TTL);
        return data;
      },
    },

    expensesBreakdown: {
      type: ExpensesBreakdownType,
      args: {
        siteId: { type: new GraphQLNonNull(GraphQLID) },
        filters:{ type: ExpensesPageFiltersInput },
      },
      async resolve(_, { siteId, filters = {} }, ctx) {
        const id = requireModuleRead(ctx, 'expenses', siteId);
        const canViewAllEntries = PRIVILEGED_ROLES.has(ctx.user.role)
          || ctx.permissions?.get('expenses')?.can_view_all === true;
        const requestedCreator = Number(filters.createdBy);
        const normalizedFilters = {
          search: filters.search || undefined,
          status: filters.status || undefined,
          mode: filters.mode || undefined,
          category: filters.category || undefined,
          categories: Array.isArray(filters.categories) && filters.categories.length > 0
            ? filters.categories.map((c) => String(c).trim()).filter(Boolean)
            : undefined,
          sub_category: filters.subCategory || undefined,
          sub_categories: Array.isArray(filters.subCategories) && filters.subCategories.length > 0
            ? filters.subCategories.map((c) => String(c).trim()).filter(Boolean)
            : undefined,
          to_entity: filters.toEntity || undefined,
          dateFrom: filters.dateFrom || undefined,
          dateTo: filters.dateTo || undefined,
          missing_bill: filters.missingBill ? 'true' : undefined,
          related_member_ids: positiveIntList(filters.relatedMemberIds),
          expense_ids: Array.isArray(filters.expenseIds) ? positiveIntList(filters.expenseIds) || [] : undefined,
          vendor_payment_id: filters.vendorPaymentId ? requirePositiveId(filters.vendorPaymentId,'vendorPaymentId') : undefined,
          ...await constructionExpenseScope(ctx.user),
          entry_origin: ['original', 'transfer'].includes(filters.entryOrigin) ? filters.entryOrigin : undefined,
          order: filters.order || 'desc',
          only_site: filters.onlySite === false ? undefined : 'true',
          created_by: canViewAllEntries
            ? (Number.isInteger(requestedCreator) && requestedCreator > 0 ? requestedCreator : undefined)
            : Number(ctx.user.id),
        };

        const key = `expenses:breakdown:${ctx.user.id || 'anon'}:${id}:${serializeFilters(normalizedFilters)}`;

        if (cacheEnabled() && !normalizedFilters.include_vendor) {
          const cached = await cacheGet(key);
          if (cached) return cached;
        }

        const data = await getExpensesBreakdown(id, { filters: normalizedFilters });

        if (cacheEnabled() && !normalizedFilters.include_vendor) await cacheSet(key, data, CACHE_TTL);
        return data;
      },
    },

    // ── Plot Payments queries ──

    plotPageData: {
      type: PlotPageDataType,
      args: {
        siteId: { type: new GraphQLNonNull(GraphQLID) },
        createdBy: { type: GraphQLInt },
      },
      async resolve(_, { siteId, createdBy }, ctx) {
        const id = requireModuleRead(ctx, 'plot_payments', siteId);
        const canViewAll = ['admin', 'super_admin'].includes(ctx.user?.role)
          || ctx.permissions?.get('plot_payments')?.can_view_all === true;
        const creatorId = canViewAll ? (createdBy || null) : Number(ctx.user.id);
        const key = `plots:pageData:${id}:creator:${creatorId || 'all'}`;

        if (cacheEnabled()) {
          const cached = await cacheGet(key);
          if (cached) return cached;
        }

        const data = await getPlotPageData(id, creatorId);

        if (cacheEnabled()) await cacheSet(key, data, 60); // 1 min cache
        return data;
      },
    },

    plotPaymentDetail: {
      type: PlotPaymentDetailType,
      args: {
        plotId: { type: new GraphQLNonNull(GraphQLID) },
        siteId: { type: new GraphQLNonNull(GraphQLID) },
        createdBy: { type: GraphQLInt },
      },
      async resolve(_, { plotId, siteId, createdBy }, ctx) {
        const id = requireModuleRead(ctx, 'plot_payments', siteId);
        const canViewAll = ['admin', 'super_admin'].includes(ctx.user?.role)
          || ctx.permissions?.get('plot_payments')?.can_view_all === true;
        const creatorId = canViewAll ? (createdBy || null) : Number(ctx.user.id);
        const data = await getPlotPaymentDetail(requirePositiveId(plotId, 'plotId'), id, creatorId);
        return data;
      },
    },

    registryBankChequePayments: {
      type: new GraphQLList(RegistryLinkablePaymentType),
      args: {
        siteId: { type: new GraphQLNonNull(GraphQLID) },
        createdBy: { type: GraphQLInt },
      },
      async resolve(_, { siteId, createdBy }, ctx) {
        const id = requireModuleRead(ctx, 'plot_registry', siteId);
        const canViewAll = ['admin', 'super_admin'].includes(ctx.user?.role)
          || ctx.permissions?.get('plot_registry')?.can_view_all === true;
        const creatorId = canViewAll ? (createdBy || null) : Number(ctx.user.id);
        return getRegistryBankChequePayments(id, creatorId);
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
        const id = requireModuleRead(ctx, 'dashboard', siteId);
        await clearCacheByPrefixes([`dashboard:*:${id}:`]);
        return true;
      },
    },

    invalidatePlotCache: {
      type: GraphQLBoolean,
      args: {
        siteId: { type: new GraphQLNonNull(GraphQLID) },
      },
      async resolve(_, { siteId }, ctx) {
        const id = requireModuleRead(ctx, 'plot_payments', siteId);
        await clearCacheByPrefixes([`plots:pageData:${id}`]);
        return true;
      },
    },
  },
});

export const schema = new GraphQLSchema({
  query: QueryType,
  mutation: MutationType,
});
