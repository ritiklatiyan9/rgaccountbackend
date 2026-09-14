import asyncHandler from '../utils/asyncHandler.js';
import pool from '../config/db.js';

const MAX_AMOUNT = 1_000_000_000_000;

const cleanText = (value, max) => String(value ?? '').trim().slice(0, max);
const cleanAmount = (value, label) => {
  const amount = Number(value ?? 0);
  if (!Number.isFinite(amount) || amount < 0 || amount > MAX_AMOUNT) {
    throw new Error(`${label} must be between 0 and ${MAX_AMOUNT}.`);
  }
  return Math.round(amount * 100) / 100;
};

const cleanDocument = (input) => {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  if (!Array.isArray(source.sites)) throw new Error('sites must be an array.');
  if (source.sites.length > 100) throw new Error('A sandbox can contain at most 100 sites.');

  const sites = source.sites.map((site, siteIndex) => {
    if (!site || typeof site !== 'object' || Array.isArray(site)) throw new Error(`Site ${siteIndex + 1} is invalid.`);
    if (!Array.isArray(site.partners)) throw new Error(`Partners for site ${siteIndex + 1} must be an array.`);
    if (site.partners.length > 100) throw new Error(`Site ${siteIndex + 1} can contain at most 100 partners.`);
    const siteName = cleanText(site.siteName, 120);
    if (!siteName) throw new Error(`Site ${siteIndex + 1} needs a name.`);
    const parsedSiteId = Number.parseInt(site.siteId, 10);

    return {
      id: cleanText(site.id, 80) || `site-${siteIndex + 1}`,
      siteId: Number.isInteger(parsedSiteId) && parsedSiteId > 0 ? parsedSiteId : null,
      siteName,
      plotSaleValue: cleanAmount(site.plotSaleValue, 'Plot sale value'),
      plotReceived: cleanAmount(site.plotReceived, 'Plot money received'),
      landBookProfit: cleanAmount(site.landBookProfit, 'Land book profit'),
      landReceived: cleanAmount(site.landReceived, 'Land money received'),
      paidLandCost: cleanAmount(site.paidLandCost, 'Paid land cost'),
      runningExpenses: cleanAmount(site.runningExpenses, 'Running expenses'),
      partners: site.partners.map((partner, partnerIndex) => {
        const name = cleanText(partner?.name, 120);
        if (!name) throw new Error(`Partner ${partnerIndex + 1} in ${siteName} needs a name.`);
        const sharePct = Number(partner?.sharePct ?? 0);
        if (!Number.isFinite(sharePct) || sharePct < 0 || sharePct > 100) {
          throw new Error(`Partner shares in ${siteName} must be between 0 and 100%.`);
        }
        return {
          id: cleanText(partner?.id, 80) || `partner-${partnerIndex + 1}`,
          name,
          sharePct: Math.round(sharePct * 10000) / 10000,
          paid: cleanAmount(partner?.paid, 'Partner paid amount'),
        };
      }),
    };
  });

  return {
    version: 1,
    asOf: /^\d{4}-\d{2}-\d{2}$/.test(String(source.asOf || '')) ? source.asOf : '',
    notes: cleanText(source.notes, 4000),
    sites,
  };
};

const row = (item) => ({
  id: Number(item.id),
  title: item.title,
  document: item.document,
  createdAt: item.created_at,
  updatedAt: item.updated_at,
});

export const listManualProfitSandboxes = asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, title, document, created_at, updated_at
       FROM manual_profit_sandboxes
      WHERE owner_user_id = $1
      ORDER BY updated_at DESC, id DESC`,
    [req.user.id],
  );
  res.json({ sandboxes: rows.map(row) });
});

export const createManualProfitSandbox = asyncHandler(async (req, res) => {
  const title = cleanText(req.body?.title, 120);
  if (!title) return res.status(400).json({ message: 'A sandbox name is required.' });
  let document;
  try { document = cleanDocument(req.body?.document ?? { sites: [] }); }
  catch (error) { return res.status(400).json({ message: error.message }); }
  const { rows } = await pool.query(
    `INSERT INTO manual_profit_sandboxes (owner_user_id, title, document)
     VALUES ($1, $2, $3::jsonb)
     RETURNING id, title, document, created_at, updated_at`,
    [req.user.id, title, JSON.stringify(document)],
  );
  res.status(201).json({ sandbox: row(rows[0]) });
});

export const updateManualProfitSandbox = asyncHandler(async (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ message: 'A valid sandbox is required.' });
  const title = cleanText(req.body?.title, 120);
  if (!title) return res.status(400).json({ message: 'A sandbox name is required.' });
  let document;
  try { document = cleanDocument(req.body?.document); }
  catch (error) { return res.status(400).json({ message: error.message }); }
  const { rows } = await pool.query(
    `UPDATE manual_profit_sandboxes
        SET title = $1, document = $2::jsonb, updated_at = NOW()
      WHERE id = $3 AND owner_user_id = $4
      RETURNING id, title, document, created_at, updated_at`,
    [title, JSON.stringify(document), id, req.user.id],
  );
  if (!rows[0]) return res.status(404).json({ message: 'Manual profit sandbox not found.' });
  res.json({ sandbox: row(rows[0]) });
});

export const deleteManualProfitSandbox = asyncHandler(async (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ message: 'A valid sandbox is required.' });
  const result = await pool.query(
    'DELETE FROM manual_profit_sandboxes WHERE id = $1 AND owner_user_id = $2',
    [id, req.user.id],
  );
  if (!result.rowCount) return res.status(404).json({ message: 'Manual profit sandbox not found.' });
  res.json({ message: 'Manual profit sandbox deleted.' });
});

export { cleanDocument };
