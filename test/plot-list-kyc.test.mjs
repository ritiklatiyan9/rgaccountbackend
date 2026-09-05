import assert from 'node:assert/strict';
import test from 'node:test';
import { validate } from 'graphql';
import { schema } from '../src/graphql/schema.js';
import { GET_PLOT_PAGE_DATA } from '../../rgaccount/src/graphql/queries.js';

test('the Plot Payments list query requests buyer KYC and validates against the API schema', () => {
  assert.deepEqual(validate(schema, GET_PLOT_PAGE_DATA), []);
  const pageSelection = GET_PLOT_PAGE_DATA.definitions[0].selectionSet.selections[0];
  const plotSelection = pageSelection.selectionSet.selections.find((field) => field.name.value === 'plots');
  const fields = plotSelection.selectionSet.selections.map((field) => field.name.value);
  assert.ok(fields.includes('buyer_member_id'));
  assert.ok(fields.includes('buyer_kyc_status'));
});
