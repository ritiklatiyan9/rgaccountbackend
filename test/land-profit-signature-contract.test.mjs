import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const readController = () => readFile(
  new URL('../src/controllers/signature.controller.js', import.meta.url),
  'utf8',
);

test('Land Profit receipts can store signatures under Farmers permission', async () => {
  const controller = await readController();

  assert.match(
    controller,
    /land_deal_payment:\s*\{[\s\S]*?table: 'land_deal_payments',[\s\S]*?perm: 'farmers',[\s\S]*?SELECT site_id FROM land_deal_payments WHERE id = \$1 LIMIT 1/,
  );
});
