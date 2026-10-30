import { signExpenseDocuments } from '../utils/expenseDocumentUrls.js';

// Approval rows have already passed the queue's visibility rules. Before
// signing a private attachment, also verify its site and organisation; never
// sign an arbitrary URL supplied by the browser.
export async function signApprovalVoucherLinks(entries, user, database, sign = signExpenseDocuments) {
  const siteIds = [...new Set(entries.filter(entry => entry.voucher_url || entry.bill_url || entry.voucher_urls?.length || entry.bill_urls?.length)
    .map(entry => Number(entry.site_id)).filter(id => Number.isSafeInteger(id) && id > 0))];
  if (!siteIds.length) return entries;
  const { rows } = await database.query(`SELECT s.id FROM sites s WHERE s.id=ANY($1::int[])
    AND ($2::boolean OR s.organization_id=$3)
    AND ($4::boolean OR EXISTS (SELECT 1 FROM user_sites us WHERE us.site_id=s.id AND us.user_id=$5))`,
  [siteIds, user.role === 'super_admin', Number(user.organization_id) || 1,
    ['admin', 'super_admin'].includes(user.role), user.id]);
  const allowed = new Set(rows.map(row => Number(row.id)));
  return Promise.all(entries.map(entry => allowed.has(Number(entry.site_id)) ? sign(entry) : entry));
}
