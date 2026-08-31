#!/usr/bin/env node
// Undoes om-imprest-reset.mjs — puts the archived imprest history back and
// returns Kuldeep Tomar's admin float to ₹8,15,067.
//
//   node scripts/om-imprest-reset-revert.mjs          # dry run
//   node scripts/om-imprest-reset-revert.mjs --yes    # apply
import { restore, commitRequested } from './omimprest.lib.mjs';

await restore({ commit: commitRequested() });
