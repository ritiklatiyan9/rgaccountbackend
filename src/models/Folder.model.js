import MasterModel from './MasterModel.js';

class FolderModel extends MasterModel {
    constructor() {
        super('file_folders');
    }

    /**
     * List folders inside a given parent folder (or root if null) scoped by site
     */
    async listByParent(parentId, siteId, pool) {
        const folderQuery = `
            SELECT ff.id, ff.name, ff.parent_id, ff.site_id, ff.created_by, ff.created_at, ff.updated_at,
                   u.name as creator_name,
                   'folder' as item_type
            FROM file_folders ff
            LEFT JOIN users u ON ff.created_by = u.id
            WHERE ff.site_id = $1
              AND ${parentId ? 'ff.parent_id = $2' : 'ff.parent_id IS NULL'}
            ORDER BY ff.name ASC
        `;
        const folderParams = parentId ? [siteId, parentId] : [siteId];
        const folders = await pool.query(folderQuery, folderParams);
        return folders.rows;
    }

    /**
     * Create a new folder
     */
    async createFolder(name, parentId, siteId, userId, pool) {
        const query = `
            INSERT INTO file_folders (name, parent_id, site_id, created_by)
            VALUES ($1, $2, $3, $4)
            RETURNING *
        `;
        const result = await pool.query(query, [name, parentId || null, siteId, userId]);
        return result.rows[0];
    }

    /**
     * Rename a folder
     */
    async renameFolder(id, name, pool) {
        const query = `
            UPDATE file_folders SET name = $2, updated_at = NOW()
            WHERE id = $1
            RETURNING *
        `;
        const result = await pool.query(query, [id, name]);
        return result.rows[0];
    }

    /**
     * Delete a folder and all its contents (cascade via FK)
     */
    async deleteFolder(id, pool) {
        // First delete all files in this folder (and sub-folders recursively)
        // The FK cascade on file_folders handles sub-folders,
        // but we need to handle excel_files manually (they SET NULL on folder delete)
        // So we delete files in the folder tree first
        const deleteFilesQuery = `
            WITH RECURSIVE folder_tree AS (
                SELECT id FROM file_folders WHERE id = $1
                UNION ALL
                SELECT ff.id FROM file_folders ff
                JOIN folder_tree ft ON ff.parent_id = ft.id
            )
            DELETE FROM excel_files WHERE folder_id IN (SELECT id FROM folder_tree)
            RETURNING s3_key
        `;
        const deletedFiles = await pool.query(deleteFilesQuery, [id]);

        // Then delete the folder (cascades to sub-folders)
        const query = `DELETE FROM file_folders WHERE id = $1 RETURNING *`;
        const result = await pool.query(query, [id]);

        return { folder: result.rows[0], deletedS3Keys: deletedFiles.rows.map(r => r.s3_key).filter(Boolean) };
    }

    /**
     * Get breadcrumb path for a folder
     */
    async getBreadcrumb(folderId, pool) {
        if (!folderId) return [];
        const query = `
            WITH RECURSIVE path AS (
                SELECT id, name, parent_id FROM file_folders WHERE id = $1
                UNION ALL
                SELECT ff.id, ff.name, ff.parent_id
                FROM file_folders ff
                JOIN path p ON ff.id = p.parent_id
            )
            SELECT id, name, parent_id FROM path ORDER BY id ASC
        `;
        const result = await pool.query(query, [folderId]);
        return result.rows;
    }
}

export const folderModel = new FolderModel();
