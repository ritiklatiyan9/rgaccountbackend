import { normalizeMemberName } from './memberPhoneReuse.service.js';

const tokens = (value) => String(value || '').normalize('NFKC').toUpperCase()
  .replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ').trim().split(/\s+/)
  .filter((part) => part && !['MR', 'MRS', 'MS', 'DR', 'SHRI', 'SHREE'].includes(part));

// Allow one spelling edit on a full name token, never just a shared first name.
const closeToken = (left, right) => {
  if (left === right) return true;
  if (Math.min(left.length, right.length) < 4 || Math.abs(left.length - right.length) > 1) return false;
  let i = 0, j = 0, edits = 0;
  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (left.length >= right.length) i++;
    if (right.length >= left.length) j++;
  }
  return edits + Number(i < left.length || j < right.length) <= 1;
};

export const relatedIdentityName = (candidate, reference, { allowInitials = false } = {}) => {
  const exact = normalizeMemberName(reference);
  if (!exact) return false;
  if (normalizeMemberName(candidate) === exact) return true;
  const desired = tokens(reference), actual = tokens(candidate);
  if (desired.length < 2 || actual.length < 2 || !closeToken(desired[0], actual[0])) return false;
  const surname = desired.at(-1);
  return actual.slice(1).some((part) => closeToken(part, surname)
    || (allowInitials && desired[0] === actual[0] && Math.min(part.length, surname.length) === 1 && part[0] === surname[0]));
};
