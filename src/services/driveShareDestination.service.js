import pool from '../config/db.js';
import { MODULE_FOLDER } from './plotCommissionShare.service.js';

/** Keep one plot's exports together across days and display-name changes.
 * Only adopt a path cached under the currently connected root and this site;
 * reconnecting a different Drive must never reuse an old account's folder.
 * ensureFolderPath subsequently validates/recreates the folder in Drive. */
export const existingShareFolderSegments = async ({ orgId, siteId, plotId, rootFolderId }, fallback) => {
  if (!rootFolderId) return fallback;
  const prefix = `site:${siteId}/`;
  const { rows } = await pool.query(
    `SELECT f.path
       FROM google_drive_shares s
       JOIN google_drive_folders f ON f.organization_id=s.organization_id AND f.folder_id=s.folder_id
      WHERE s.organization_id=$1 AND s.site_id=$2 AND s.module='plot_commission'
        AND s.entity_type='plot' AND s.entity_id=$3 AND s.folder_id IS NOT NULL
        AND f.root_folder_id=$4 AND starts_with(f.path,$5)
      ORDER BY s.id ASC LIMIT 1`,
    [orgId, siteId, plotId, rootFolderId, prefix],
  );
  const segments = rows[0]?.path?.slice(prefix.length).split('/');
  return segments?.length === 3 && segments[1] === MODULE_FOLDER && segments.every(Boolean) ? segments : fallback;
};

/** Reuse the first destination for this module/record, within the current Drive. */
export const existingModuleShareFolderSegments = async ({ orgId, siteId, moduleKey, entityType, entityId, moduleLabel, rootFolderId }, fallback) => {
  if (!rootFolderId) return fallback;
  const prefix = `site:${siteId}/`;
  const { rows } = await pool.query(
    `SELECT f.path FROM google_drive_shares s
       JOIN google_drive_folders f ON f.organization_id=s.organization_id AND f.folder_id=s.folder_id
      WHERE s.organization_id=$1 AND s.site_id=$2 AND s.module=$3
        AND s.entity_type=$4 AND s.entity_id=$5 AND s.folder_id IS NOT NULL
        AND f.root_folder_id=$6 AND starts_with(f.path,$7)
      ORDER BY s.id ASC LIMIT 1`,
    [orgId, siteId, moduleKey, entityType, entityId, rootFolderId, prefix],
  );
  const segments = rows[0]?.path?.slice(prefix.length).split('/');
  return segments?.length === 3 && segments[1] === moduleLabel && segments.every(Boolean) ? segments : fallback;
};
