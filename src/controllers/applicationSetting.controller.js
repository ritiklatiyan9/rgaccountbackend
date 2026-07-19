import asyncHandler from '../utils/asyncHandler.js';
import pool from '../config/db.js';
import applicationSettingModel, { FEATURE_KEYS } from '../models/ApplicationSetting.model.js';

const getAccessibleSiteId = async (req, res, rawSiteId) => {
  const siteId = Number.parseInt(rawSiteId, 10);
  if (!Number.isInteger(siteId) || siteId <= 0) {
    res.status(400).json({ message: 'A valid site_id is required' });
    return null;
  }

  const { rows } = await pool.query('SELECT id FROM sites WHERE id = $1 LIMIT 1', [siteId]);
  if (!rows[0]) {
    res.status(404).json({ message: 'Site not found' });
    return null;
  }

  if (req.user.role !== 'admin' && req.user.role !== 'super_admin') {
    const access = await pool.query(
      'SELECT 1 FROM user_sites WHERE user_id = $1 AND site_id = $2 LIMIT 1',
      [req.user.id, siteId]
    );
    if (!access.rows[0]) {
      res.status(403).json({ message: 'Access denied to this site' });
      return null;
    }
  }

  return siteId;
};

/** GET /settings/features?site_id=123 */
export const getFeatures = asyncHandler(async (req, res) => {
  const siteId = await getAccessibleSiteId(req, res, req.query.site_id);
  if (!siteId) return;

  const features = await applicationSettingModel.getFeatures(siteId);
  res.json({ site_id: siteId, features });
});

/** PUT /settings/features/plot-registry-workflow-unlocked */
export const updatePlotRegistryWorkflow = asyncHandler(async (req, res) => {
  const siteId = await getAccessibleSiteId(req, res, req.body.site_id);
  if (!siteId) return;

  if (typeof req.body.enabled !== 'boolean') {
    return res.status(400).json({ message: 'enabled must be a boolean' });
  }

  const enabled = await applicationSettingModel.setFeature(
    siteId,
    FEATURE_KEYS.PLOT_REGISTRY_WORKFLOW_UNLOCKED,
    req.body.enabled,
    req.user.id
  );

  res.json({
    site_id: siteId,
    features: { [FEATURE_KEYS.PLOT_REGISTRY_WORKFLOW_UNLOCKED]: enabled },
    message: enabled
      ? 'Plot Registry flexible navigation enabled'
      : 'Plot Registry sequential workflow restored',
  });
});
