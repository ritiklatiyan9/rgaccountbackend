/**
 * Expenses GraphQL Service
 * Reuses the existing unified expense model (expenses + mapped modules).
 */
import pool from '../../config/db.js';
import { expenseModel } from '../../models/Expense.model.js';

const DEFAULT_SUMMARY = {
  total_debit: 0,
  total_credit: 0,
  total_count: 0,
};

function normalizeFilters(filters = {}) {
  const normalized = {
    search: filters.search?.trim() || undefined,
    mode: filters.mode || undefined,
    category: filters.category || undefined,
    to_entity: filters.to_entity || undefined,
    dateFrom: filters.dateFrom || undefined,
    dateTo: filters.dateTo || undefined,
    order: String(filters.order || 'desc').toLowerCase() === 'asc' ? 'asc' : 'desc',
  };

  if (filters.missing_bill === true || filters.missing_bill === 'true') {
    normalized.missing_bill = 'true';
  }
  if (filters.only_site === true || filters.only_site === 'true') {
    normalized.only_site = 'true';
  }

  return normalized;
}

export async function getExpensesPageData(siteId, { filters = {}, page = 1, limit = 20 } = {}) {
  const safeSiteId = parseInt(siteId, 10);
  const safePage = Number.isFinite(page) ? Math.max(1, parseInt(page, 10) || 1) : 1;
  const rawLimit = Number.isFinite(limit) ? parseInt(limit, 10) : 20;
  const safeLimit = rawLimit < 0 ? 0 : rawLimit;

  const normalizedFilters = normalizeFilters(filters);

  const [paginatedData, breakdowns] = await Promise.all([
    expenseModel.findPaginatedUnified(safeSiteId, normalizedFilters, safePage, safeLimit, pool),
    expenseModel.getUnifiedBreakdowns(safeSiteId, normalizedFilters, pool),
  ]);

  const totalItems = parseInt(paginatedData.totalItems || 0, 10);

  return {
    expenses: paginatedData.items || [],
    summary: paginatedData.summary || DEFAULT_SUMMARY,
    pagination: {
      totalItems,
      totalPages: safeLimit > 0 ? Math.ceil(totalItems / safeLimit) : 1,
      currentPage: safePage,
      itemsPerPage: safeLimit > 0 ? safeLimit : totalItems,
    },
    modeBreakdown: breakdowns.modeBreakdown || [],
    categoryBreakdown: breakdowns.categoryBreakdown || [],
  };
}
