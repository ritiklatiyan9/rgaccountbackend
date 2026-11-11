import test from 'node:test';
import assert from 'node:assert/strict';
import { overdueNotice, overdueDedupeKey, overdueTemplateBody, normalizeOverduePolicy } from '../src/services/installmentOverduePolicy.service.js';
import { compileAccountWhatsAppBody } from '../src/services/accountWhatsApp.spec.js';

const annual = { enabled: true, kind: 'annual_interest', annual_rate: 18 };
const shop = { enabled: true, kind: 'shop_price_increase', amount: 50000, frequency: 'once_per_shop' };

test('annual interest uses only the unpaid overdue principal and whole India calendar days', () => {
  const installment = { remaining: 50000, due_date: '2026-11-09' };
  assert.equal(overdueNotice(annual, installment, 'plot', new Date('2026-11-09T18:29:59Z')), null);
  assert.equal(overdueNotice(annual, installment, 'plot', new Date('2026-11-09T18:30:00Z')).penalty_amount, 24.66);
  assert.equal(overdueNotice(annual, { ...installment, remaining: 25000 }, 'plot', '2026-11-10').penalty_amount, 12.33);
  assert.equal(overdueNotice(annual, { remaining: 100000, due_date: '2025-11-10' }, 'plot', '2026-11-10').penalty_amount, 18000);
  for (const remaining of [0, -1, NaN]) assert.equal(overdueNotice(annual, { ...installment, remaining }, 'plot', '2026-11-10'), null);
  assert.equal(overdueNotice(annual, { ...installment, due_date: '2026-12-01' }, 'plot', '2026-11-10'), null);
});

test('shop rule is fixed, shop-only, and deduplicates across missed installments when configured once per shop', () => {
  assert.equal(overdueNotice(shop, { remaining: 1, due_date: '2026-11-09' }, 'shop', '2026-11-10').penalty_amount, 50000);
  assert.equal(overdueNotice(shop, { remaining: 100000, due_date: '2026-11-09' }, 'plot', '2026-11-10'), null);
  assert.equal(overdueDedupeKey(shop, 1, 20, '2026-11-09'), overdueDedupeKey(shop, 2, 20, '2026-12-09'));
  assert.notEqual(overdueDedupeKey(shop, 1, 20, '2026-11-09'), overdueDedupeKey(shop, 1, 21, '2026-11-09'));
  const perInstallment = { ...shop, frequency: 'per_installment' };
  assert.notEqual(overdueDedupeKey(perInstallment, 1, 20, '2026-11-09'), overdueDedupeKey(perInstallment, 2, 20, '2026-11-09'));
});

test('invalid/disabled rules cannot generate notices; project messages satisfy Meta template constraints', () => {
  for (const policy of [null, { ...annual, enabled: false }, { ...annual, annual_rate: -18 }, { ...shop, amount: 0 }, { ...shop, frequency: 'daily' }]) assert.equal(normalizeOverduePolicy(policy), null);
  for (const policy of [annual, shop, { ...shop, frequency: 'per_installment' }]) {
    assert.ok(compileAccountWhatsAppBody('INSTALLMENT_OVERDUE', overdueTemplateBody(policy)).text.length <= 1024);
  }
});
