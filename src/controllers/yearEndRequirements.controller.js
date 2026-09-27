import crypto from 'node:crypto';
import asyncHandler from '../utils/asyncHandler.js';
import pool from '../config/db.js';
import permissionModel from '../models/Permission.model.js';
import { getPlotDocUrl, uploadPlotDoc, deletePlotDoc } from '../utils/plotDocStorage.js';
import { collectYearEndDocuments } from '../services/yearEndDocuments.service.js';
import { getYearEndReport,parseYearEndScope,validateRequirementUpdate,REQUIREMENT_IDS,REPORT_PERMISSIONS } from '../services/yearEndRequirements.service.js';

const inFlightReports=new Map();
async function loadReport(scope,allowed) {
  const key=JSON.stringify([scope,[...allowed].sort()]);
  if(!inFlightReports.has(key)) {
    const pending=getYearEndReport(scope,allowed).finally(()=>inFlightReports.delete(key));
    inFlightReports.set(key,pending);
  }
  // Concurrent requests may sign/filter different response objects. Share the
  // query work only, never a mutable response or a completed KYC payload cache.
  return structuredClone(await inFlightReports.get(key));
}

async function allowedReports(user) {
  if (['admin','super_admin'].includes(user.role)) return new Set([...REQUIREMENT_IDS,'firm_ledger']);
  const modules=[...new Set(Object.values(REPORT_PERMISSIONS).flat())];
  const permissions=new Map(await Promise.all(modules.map(async module => [module,await permissionModel.getPermission(user.id,module)])));
  // A year-end balance must include the whole book. Do not label a creator-only
  // subset as the site's balance, or expose data from an ungranted module.
  return new Set(Object.entries(REPORT_PERMISSIONS).filter(([,required]) => required.every(module =>
    permissions.get(module)?.can_read===true && permissions.get(module)?.can_view_all===true)).map(([key]) => key));
}

export const getYearEndRequirements = asyncHandler(async (req,res) => {
  const scope=parseYearEndScope(req.query);
  const allowed=await allowedReports(req.user);
  const report=await loadReport(scope,allowed);
  report.selectedLoanIds=scope.loanIds;
  const documents=collectYearEndDocuments(report,allowed);
  // Sign only documents the user may read. Do not leak storage keys or raw bills.
  for (const document of documents) {
    try { document.url=await getPlotDocUrl(document.file_path); } catch { document.url=null; }
    delete document.file_path;
  }
  delete report.bills;
  report.documents=documents;
  report.allowed=[...allowed];
  report.canEdit=['admin','super_admin'].includes(req.user.role);
  res.set('Cache-Control','no-store');
  res.json(report);
});

export const saveYearEndRequirement = asyncHandler(async (req,res) => {
  const scope=parseYearEndScope(req.query);
  const update=validateRequirementUpdate(req.body || {});
  const { rows }=await pool.query(`INSERT INTO balance_sheet_requirements(site_id,financial_year,requirement,status,notes,updated_by)
    VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(site_id,financial_year,requirement) DO UPDATE SET
    status=EXCLUDED.status,notes=EXCLUDED.notes,updated_by=EXCLUDED.updated_by,updated_at=NOW()
    RETURNING requirement,status,notes,updated_at`,[scope.siteId,scope.year,update.requirement,update.status,update.notes,req.user.id]);
  res.json(rows[0]);
});

export const uploadYearEndAttachment = asyncHandler(async (req,res) => {
  const scope=parseYearEndScope(req.query);
  const requirement=String(req.body.requirement || '');
  if (!REQUIREMENT_IDS.includes(requirement)) return res.status(400).json({message:'Select a valid requirement.'});
  if (!req.file) return res.status(400).json({message:'Choose a supporting document.'});
  const date=String(req.body.document_date || '');
  if (date && (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0,10)!==date)) return res.status(400).json({message:'Enter a valid document date.'});
  if (requirement==='registries' && !date) return res.status(400).json({message:'Registry copies need a registry date for the filename.'});
  const metadata={requirement,financial_year:scope.year,party:String(req.body.party || '').trim().slice(0,200),site_id:scope.siteId};
  let key;
  try {
    key=await uploadPlotDoc(req.file.buffer,req.file.originalname,req.file.mimetype,'year_end_documents');
    const {rows}=await pool.query(`INSERT INTO documents(site_id,type,category,title,original_name,file_path,file_hash,mime_type,file_size,
      ocr_status,ocr_engine,uploaded_source,uploaded_by,entity_type,entity_id,metadata,doc_date)
      VALUES($1,'OTHER','OTHER',$2,$2,$3,$4,$5,$6,'DONE','none','ACCOUNT_RECORD',$7,'balance_sheet_requirement',$8,$9,$10)
      RETURNING id`,[scope.siteId,req.file.originalname,key,crypto.createHash('sha256').update(req.file.buffer).digest('hex'),req.file.mimetype,req.file.size,req.user.id,scope.year,metadata,date || null]);
    res.status(201).json({id:rows[0].id});
  } catch (error) { if (key) await deletePlotDoc(key).catch(()=>{}); throw error; }
});
