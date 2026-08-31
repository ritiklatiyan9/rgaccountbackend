#!/usr/bin/env node
// OM ASSOCIATES — zero every imprest float and clear the imprest history, so
// imprest restarts from the full Site Balance of ₹34,94,465.62.
// Cash and bank are not touched; the script aborts if either moves.
//
//   node scripts/om-imprest-reset.mjs          # dry run
//   node scripts/om-imprest-reset.mjs --yes    # apply
import { reset, commitRequested } from './omimprest.lib.mjs';

await reset({ commit: commitRequested() });
