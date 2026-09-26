import applicationSettingModel, { FEATURE_KEYS } from '../models/ApplicationSetting.model.js';

export const isRegistryStatusTransitionBlocked = async (siteId, currentStatus, nextStatus, settings = applicationSettingModel, db) => {
  if (nextStatus === currentStatus) return false;
  if (nextStatus === 'REGISTRY') {
    return settings.isFeatureEnabled(siteId, FEATURE_KEYS.NOC_REQUIRED_FOR_REGISTRY, db);
  }
  return currentStatus === 'REGISTRY';
};
