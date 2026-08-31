#!/usr/bin/env node
// Brings ₹4,53,570 of duplicate commission debits BACK into the OM ASSOCIATES
// cash book. Cash balance 36,66,962 → 32,13,392.
//
//   node scripts/om-restore-453570.mjs          # dry run, shows the effect
//   node scripts/om-restore-453570.mjs --yes    # apply
import { restore, commitRequested } from './om453570.lib.mjs';

await restore({ commit: commitRequested() });
