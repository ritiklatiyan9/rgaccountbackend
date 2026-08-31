#!/usr/bin/env node
// Undoes om-restore-453570.mjs — removes the duplicate commission debits again
// and returns OM ASSOCIATES to its current figure. 32,13,392 → 36,66,962.
//
//   node scripts/om-revert-453570.mjs           # dry run, shows the effect
//   node scripts/om-revert-453570.mjs --yes     # apply
import { revert, commitRequested } from './om453570.lib.mjs';

await revert({ commit: commitRequested() });
