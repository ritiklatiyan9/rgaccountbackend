import assert from 'node:assert/strict';
import test from 'node:test';
import pool from '../src/config/db.js';
import applicationSettingModel, { FEATURE_KEYS } from '../src/models/ApplicationSetting.model.js';
import { isRegistryStatusTransitionBlocked } from '../src/services/registryStatusPolicy.service.js';

test('Registry NOC requirement defaults on and respects a site-specific override', async () => {
  const originalQuery = pool.query;
  pool.query = async (_sql, params) => ({
    rows: Number(params[0]) === 5
      ? [{ setting_key: FEATURE_KEYS.NOC_REQUIRED_FOR_REGISTRY, setting_value: false }]
      : [],
  });
  try {
    assert.equal(await applicationSettingModel.isFeatureEnabled(2, FEATURE_KEYS.NOC_REQUIRED_FOR_REGISTRY), true);
    assert.equal(await applicationSettingModel.isFeatureEnabled(5, FEATURE_KEYS.NOC_REQUIRED_FOR_REGISTRY), false);
    assert.equal((await applicationSettingModel.getFeatures(2))[FEATURE_KEYS.NOC_REQUIRED_FOR_REGISTRY], true);
    assert.equal((await applicationSettingModel.getFeatures(5))[FEATURE_KEYS.NOC_REQUIRED_FOR_REGISTRY], false);
  } finally {
    pool.query = originalQuery;
  }
});

test('Registry transition is allowed only when the site disables its NOC requirement', async () => {
  const required = { isFeatureEnabled: async () => true };
  const optional = { isFeatureEnabled: async () => false };
  assert.equal(await isRegistryStatusTransitionBlocked(5, 'BOOKED', 'REGISTRY', required), true);
  assert.equal(await isRegistryStatusTransitionBlocked(5, 'BOOKED', 'REGISTRY', optional), false);
  assert.equal(await isRegistryStatusTransitionBlocked(5, 'REGISTRY', 'BOOKED', optional), true);
  assert.equal(await isRegistryStatusTransitionBlocked(5, 'BOOKED', 'RESALE', required), false);
  assert.equal(await isRegistryStatusTransitionBlocked(5, 'REGISTRY', 'REGISTRY', required), false);
});
