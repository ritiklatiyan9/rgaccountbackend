import { REQUIREMENT_IDS } from './yearEndRequirements.service.js';

export const safeFilePart = value => String(value || 'Unassigned').replace(/[\\/<>:"|?*\x00-\x1f]/g,'_').replace(/\.{2,}/g,'_').trim().slice(0,100) || 'Unassigned';

export function collectYearEndDocuments(report, allowed) {
  const result = [];
  const add = (document, requirement, owner = {}) => {
    if (!allowed.has(requirement)) return;
    const name = document.original_name || document.title || 'document';
    const extension = /\.[a-z0-9]{1,8}$/i.exec(name)?.[0] || ({'application/pdf':'.pdf','image/jpeg':'.jpg','image/png':'.png','image/webp':'.webp'}[document.mime_type] || '');
    const date = owner.date || document.date || 'Undated';
    result.push({ id: `${requirement}-${document.id}`, requirement, title:document.title || name,
      party:owner.party || document.farmer || '', firm:owner.firm || 'Unassigned firm', date,
      file_path:document.file_path, file_size:document.file_size,
      download_name:`${safeFilePart(date)}_${safeFilePart(owner.party || document.farmer || name.replace(/\.[^.]+$/,''))}_${safeFilePart(document.id)}${extension}` });
  };
  for (const document of report.documents) {
    if (document.entity_type === 'balance_sheet_requirement') {
      const metadata = document.metadata || {};
      if (Number(metadata.financial_year)===report.period.financial_year && REQUIREMENT_IDS.includes(metadata.requirement)) {
        add(document,metadata.requirement,{ party:metadata.party,firm:metadata.firm,date:document.date });
      }
      continue;
    }
    const registries=report.reports.registries?.rows || [];
    const directRegistry=document.entity_type==='registry' ? registries.find(row=>Number(document.entity_id)===row.id):null;
    const plotRegistries=document.plot_id && String(document.category).toUpperCase()==='REGISTRY'
      ? registries.filter(row=>row.plot_id===document.plot_id):[];
    const datedRegistries=plotRegistries.filter(row=>row.registry_date===document.date);
    const registry=directRegistry || (plotRegistries.length===1?plotRegistries[0]:datedRegistries.length===1?datedRegistries[0]:null);
    if (registry) add(document,'registries',{ party:`${registry.party || 'Party'}_Plot-${registry.plot_no}`,firm:registry.firm,date:registry.registry_date });
    else if(plotRegistries.length) {
      // Several deeds/resales can share a plot. Do not invent a registry date
      // or buyer from whichever row happens to sort first.
      add(document,'registries',{party:`Plot-${plotRegistries[0].plot_no}`,date:document.date || 'Registry-date-needs-review'});
    }
    if (document.farmer_id && document.category==='AGREEMENT') add(document,'farmer_mous');
    if (document.farmer_id && document.category==='LAND_RECORD') {
      const land=report.reports.land_purchases?.rows.find(r => r.farmer_id===document.farmer_id);
      if (land) add(document,'land_purchases',{party:land.farmer,date:land.date});
    }
    if (document.entity_type==='cashflow' && report.selectedLoanIds.includes(Number(document.entity_id))) {
      add(document,'loans',{party:report.loanAccounts.find(a => a.id===Number(document.entity_id))?.name});
    }
  }
  for (const bill of report.bills) {
    [...new Set([bill.bill_url,...(bill.bill_urls || [])].filter(Boolean))].forEach((url,index) => {
      let name='Bill';
      try { name=decodeURIComponent(new URL(url).pathname.split('/').pop()) || name; } catch { /* storage key */ }
      add({id:`bill-${bill.id}-${index}`,title:`Purchase bill · ${bill.party || 'Party missing'}`,original_name:name,file_path:url},'purchase_bills',{party:bill.party,date:bill.date});
    });
  }
  return result;
}
