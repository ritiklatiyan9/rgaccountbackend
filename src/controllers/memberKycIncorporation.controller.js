import pool from '../config/db.js';
import asyncHandler from '../utils/asyncHandler.js';
import { incorporateMemberKyc, listMemberKycSources } from '../services/memberKycIncorporation.service.js';

export const getKycSources = asyncHandler(async (req, res) => {
  res.json(await listMemberKycSources(pool, { user: req.user, memberId: req.params.id }));
});

export const incorporateKyc = asyncHandler(async (req, res) => {
  res.json(await incorporateMemberKyc(pool, {
    user: req.user, memberId: req.params.id, sourceMemberId: req.body?.source_member_id,
    samePersonConfirmed: req.body?.same_person_confirmed === true,
  }));
});
