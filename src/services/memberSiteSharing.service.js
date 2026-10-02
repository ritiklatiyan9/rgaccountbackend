import { randomUUID } from 'node:crypto';
import { MEMBER_FIELDS, DOC_FIELDS } from './memberProfileFields.js';
import { memberModel } from '../models/Member.model.js';
import { assertMemberSiteAccess, normalizeMemberName, normalizeMemberPhone, REUSABLE_KYC_PROFILE_FIELDS, reuseVerifiedKycForMember } from './memberPhoneReuse.service.js';
import { copyIncorporatedKycDocuments } from './memberKycDocuments.service.js';

const SHARED_FIELDS=[...new Set([...REUSABLE_KYC_PROFILE_FIELDS,...DOC_FIELDS])];
const copyFields=[...new Set([...MEMBER_FIELDS,...DOC_FIELDS,'member_types','geocode_source','geocode_precision','geocoded_at'])];
const fail=(message,statusCode=409)=>{throw Object.assign(new Error(message),{statusCode});};
const identity=value=>String(value || '').toUpperCase().replace(/[^A-Z0-9]/g,'');

// Take this before member/case row locks in every sharing mutation. Concurrent
// adds in different sites then see the committed registration instead of making
// independent copies or taking the same members in opposite lock orders.
export async function lockMemberDirectory(db,user) {
  if(!Number.isSafeInteger(Number(user?.organization_id)) || Number(user.organization_id)<=0) fail('An organisation is required.',403);
  await db.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`accounts-member-directory:${user.organization_id}`]);
}

async function loadSource(db,memberId,user) {
  const {rows}=await db.query(`SELECT m.*, k.id AS verified_kyc_case_id,
      k.verified_by AS kyc_verified_by, k.verified_at AS kyc_verified_at
    FROM members m JOIN sites s ON s.id=m.site_id
    LEFT JOIN LATERAL (SELECT id,verified_by,verified_at FROM kyc_cases
      WHERE client_member_id=m.id AND status='VERIFIED'
      ORDER BY verified_at DESC NULLS LAST,id DESC LIMIT 1) k ON true
    WHERE m.id=$1 AND s.organization_id=$2 FOR UPDATE OF m`,[memberId,user.organization_id]);
  if(!rows[0] || !await assertMemberSiteAccess(db,user,rows[0].site_id)) fail('This client is unavailable to your account.',403);
  return rows[0];
}

function matchingIdentity(source,target) {
  if(!normalizeMemberName(source.full_name) || normalizeMemberName(source.full_name)!==normalizeMemberName(target.full_name)) return false;
  for(const field of ['aadhar_no','pan_no']) {
    if(identity(source[field]) && identity(target[field]) && identity(source[field])!==identity(target[field])) return false;
  }
  return Boolean((normalizeMemberPhone(source.phone) && normalizeMemberPhone(source.phone)===normalizeMemberPhone(target.phone))
    || ['aadhar_no','pan_no'].some(field=>identity(source[field]) && identity(source[field])===identity(target[field])));
}

async function identityMatches(db,source,organizationId) {
  const {rows}=await db.query(`SELECT m.* FROM members m JOIN sites s ON s.id=m.site_id
    WHERE s.organization_id=$1 AND m.id<>$2 AND (
      ($3<>'' AND RIGHT(REGEXP_REPLACE(COALESCE(m.phone,''),'[^0-9]','','g'),10)=$3)
      OR ($4<>'' AND UPPER(REGEXP_REPLACE(COALESCE(m.aadhar_no,''),'[^A-Za-z0-9]','','g'))=$4)
      OR ($5<>'' AND UPPER(REGEXP_REPLACE(COALESCE(m.pan_no,''),'[^A-Za-z0-9]','','g'))=$5)
      OR (m.shared_profile_id=$6::uuid)) ORDER BY m.site_id,m.id FOR UPDATE OF m`,
    [organizationId,source.id,normalizeMemberPhone(source.phone),identity(source.aadhar_no),identity(source.pan_no),source.shared_profile_id || null]);
  return rows;
}

async function copyProfile(db,source,targets,fields,{fillOnly=false}={}) {
  const usable=fields.filter(field=>source[field]!==undefined);
  if(!targets.length || !usable.length) return;
  // Missing values are filled per row below, retaining their PostgreSQL types.
  if(fillOnly) {
    for(const target of targets) {
      const missing=usable.filter(field=>(target[field]===null || target[field]==='') && source[field]!==null && source[field]!=='');
      if(missing.length) await copyProfile(db,source,[target],missing);
    }
    return;
  }
  const values=usable.map(field=>source[field]);values.push(targets.map(target=>target.id));
  // Field names only come from the server whitelist above, never the request.
  const assignments=usable.map((field,index)=>`${field}=$${index+1}`);
  await db.query(`UPDATE members SET ${assignments.join(',')},updated_at=now() WHERE id=ANY($${values.length}::int[])`,values);
}

async function shareVerifiedCase(db,{source,target,user,refresh=false}) {
  if(!source.verified_kyc_case_id) return false;
  const {rows:[current]}=await db.query(`SELECT id,reused_from_case_id FROM kyc_cases
    WHERE client_member_id=$1 AND site_id=$2 AND status='VERIFIED'
    ORDER BY verified_at DESC NULLS LAST,id DESC LIMIT 1`,[target.id,target.site_id]);
  if(current?.reused_from_case_id===source.verified_kyc_case_id || (current && !refresh)) return false;
  let caseId;
  if(current) {
    const {rows:[open]}=await db.query(`SELECT id FROM kyc_cases WHERE client_member_id=$1 AND site_id=$2
      AND booking_id IS NULL AND status NOT IN ('VERIFIED','REJECTED') ORDER BY id DESC LIMIT 1 FOR UPDATE`,[target.id,target.site_id]);
    if(open) {
      await db.query(`UPDATE kyc_cases SET status='VERIFIED',verified_by=$1,verified_at=$2,
        reused_from_case_id=$3,updated_at=now() WHERE id=$4`,
        [source.kyc_verified_by || user.id,source.kyc_verified_at,source.verified_kyc_case_id,open.id]);
      caseId=open.id;
    } else {
      // Keep the prior verification as history; each new verification is auditable.
      const {rows}=await db.query(`INSERT INTO kyc_cases
        (booking_id,client_member_id,site_id,mode,status,created_by,verified_by,verified_at,reused_from_case_id,created_at,updated_at)
        VALUES(NULL,$1,$2,'MANUAL_OCR','VERIFIED',$3,$4,$5,$6,now(),now()) RETURNING id`,
        [target.id,target.site_id,user.id,source.kyc_verified_by || user.id,source.kyc_verified_at,source.verified_kyc_case_id]);
      caseId=rows[0].id;
    }
  } else {
    const result=await reuseVerifiedKycForMember(db,{source,targetMember:{...target,full_name:source.full_name},siteId:target.site_id,userId:user.id});
    if(!result.kycReused) return false;
    caseId=result.kycCaseId;
  }
  await copyIncorporatedKycDocuments(db,{sourceCaseId:source.verified_kyc_case_id,targetCaseId:caseId,
    memberId:target.id,siteId:target.site_id,userId:user.id,organizationId:user.organization_id});
  return true;
}

/** Caller owns the transaction and directory lock. Only site registrations are
 * copied: plots, bookings, balances and financial entries keep their own site. */
export async function registerMemberAcrossSites(db,{memberId,user}) {
  const source=await loadSource(db,memberId,user);
  const matches=await identityMatches(db,source,user.organization_id);
  if(matches.some(target=>!(source.shared_profile_id && target.shared_profile_id===source.shared_profile_id) && !matchingIdentity(source,target))) {
    fail('A matching mobile or identity belongs to a different client in another site. Review the existing registrations before adding this user.');
  }
  const groups=new Set([source.shared_profile_id,...matches.map(target=>target.shared_profile_id)].filter(Boolean));
  if(groups.size>1) fail('These registrations already belong to different shared profiles. Review them before adding this user.');
  const group=[...groups][0] || randomUUID();
  if(groups.size) {
    const {rows:linked}=await db.query(`SELECT m.* FROM members m JOIN sites s ON s.id=m.site_id
      WHERE s.organization_id=$1 AND m.shared_profile_id=$2 AND m.id<>$3 ORDER BY m.id FOR UPDATE OF m`,[user.organization_id,group,source.id]);
    const known=new Set(matches.map(member=>member.id));
    matches.push(...linked.filter(member=>!known.has(member.id)));
  }
  const bySite=new Map([[Number(source.site_id),source]]);
  for(const target of matches) {
    if(bySite.has(Number(target.site_id))) fail('More than one matching client exists in a site. Resolve the duplicates before adding this user.');
    bySite.set(Number(target.site_id),target);
  }
  await db.query('UPDATE members SET shared_profile_id=$1 WHERE id=ANY($2::int[])',[group,[source.id,...matches.map(target=>target.id)]]);
  source.shared_profile_id=group;
  const {rows:sites}=await db.query('SELECT id FROM sites WHERE organization_id=$1 ORDER BY id',[user.organization_id]);
  const created=[];let kycShared=0;
  for(const site of sites) {
    if(Number(site.id)===Number(source.site_id)) continue;
    let target=bySite.get(Number(site.id));
    if(!target) {
      const data={site_id:site.id,created_by:user.id,shared_profile_id:group};
      for(const field of copyFields) if(source[field]!==undefined) data[field]=source[field];
      target=await memberModel.create(data,db);created.push(target.id);
    } else {
      await copyProfile(db,source,[target],SHARED_FIELDS,{fillOnly:true});
    }
    if(await shareVerifiedCase(db,{source,target,user})) kycShared++;
  }
  return {shared_profile_id:group,site_count:sites.length,created_count:created.length,existing_count:matches.length,kyc_shared_count:kycShared};
}

/** Apply identity/KYC changes only to registrations explicitly linked at add
 * time. Historical unlinked clients are not guessed from a changed mobile. */
export async function syncSharedMemberProfile(db,{memberId,user,changedFields=[],verified=false}) {
  const source=await loadSource(db,memberId,user);
  if(!source.shared_profile_id) return {updated_count:0,kyc_shared_count:0};
  const {rows:targets}=await db.query(`SELECT m.* FROM members m JOIN sites s ON s.id=m.site_id
    WHERE s.organization_id=$1 AND m.shared_profile_id=$2 AND m.id<>$3 ORDER BY m.id FOR UPDATE OF m`,
    [user.organization_id,source.shared_profile_id,source.id]);
  const fields=verified ? SHARED_FIELDS : SHARED_FIELDS.filter(field=>changedFields.includes(field));
  if(fields.some(field=>['phone','aadhar_no','pan_no'].includes(field))) {
    const matches=await identityMatches(db,source,user.organization_id);
    if(matches.some(target=>target.shared_profile_id!==source.shared_profile_id)) fail('These identity details belong to another client in a site. No shared profile changes were saved.');
  }
  await copyProfile(db,source,targets,fields);
  let kycShared=0;
  if(verified) for(const target of targets) {
    if(await shareVerifiedCase(db,{source,target:{...target,full_name:source.full_name},user,refresh:true})) kycShared++;
  }
  return {updated_count:targets.length,kyc_shared_count:kycShared};
}
