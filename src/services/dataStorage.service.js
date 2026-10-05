export const MAX_STORAGE_FILE_BYTES = 50 * 1024 * 1024;
export const STORAGE_PAGE_SIZE = 100;

const fail = (statusCode, message) => { throw Object.assign(new Error(message), { statusCode }); };
const id = (value, label) => {
  if (!/^\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value)) || Number(value) <= 0) fail(400, `Invalid ${label}.`);
  return Number(value);
};
const parentId = (value) => value == null || value === '' ? null : id(value, 'folder');
const nameOf = (value) => {
  if (typeof value !== 'string') fail(400, 'A name is required.');
  const name = value.trim().normalize('NFC');
  if (!name || [...name].length > 255 || /[\/\\\x00-\x1f\x7f]/.test(name) || ['.', '..'].includes(name)) {
    fail(400, 'Use a name of 1–255 characters without slashes or control characters.');
  }
  return name;
};
const publicEntry = ({ storage_key, ...entry }) => entry;
const mapDatabaseError = (error) => {
  if (error.code === '23505') fail(409, 'A file or folder with this name already exists here.');
  if (error.code === '23503') fail(409, 'This folder changed. Refresh and try again.');
  throw error;
};

export function createDataStorageService(database, files) {
  async function accessibleSite(user, rawId) {
    const siteId = id(rawId, 'site');
    const { rows } = await database.query('SELECT id, organization_id FROM sites WHERE id=$1', [siteId]);
    if (!rows[0] || (user.role !== 'super_admin' && Number(rows[0].organization_id) !== Number(user.organization_id))) fail(404, 'Site not found.');
    if (!['admin', 'super_admin'].includes(user.role)) {
      const access = await database.query('SELECT 1 FROM user_sites WHERE site_id=$1 AND user_id=$2', [siteId, user.id]);
      if (!access.rows.length) fail(403, 'Access denied to this site.');
    }
    return siteId;
  }
  async function folder(db, siteId, folderId, lock = false) {
    if (folderId === null) return null;
    const { rows } = await db.query(`SELECT id, parent_id, name FROM data_storage_entries
      WHERE id=$1 AND site_id=$2 AND kind='folder' ${lock ? 'FOR SHARE' : ''}`, [folderId, siteId]);
    if (!rows[0]) fail(404, 'Folder not found in this site.');
    return rows[0];
  }
  async function transaction(work) {
    const client = await database.connect();
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      mapDatabaseError(error);
    } finally { client.release(); }
  }
  async function entry(user, rawSiteId, rawEntryId) {
    const siteId = await accessibleSite(user, rawSiteId);
    const entryId = id(rawEntryId, 'entry');
    const { rows } = await database.query('SELECT * FROM data_storage_entries WHERE id=$1 AND site_id=$2', [entryId, siteId]);
    if (!rows[0]) fail(404, 'File or folder not found.');
    return rows[0];
  }
  return {
    async list(user, query) {
      const siteId = await accessibleSite(user, query.site_id);
      const currentFolderId = parentId(query.parent_id);
      await folder(database, siteId, currentFolderId);
      const search = String(query.q || '').trim().slice(0, 255).replace(/[\\%_]/g, '\\$&');
      const offset = Math.max(0, Math.min(Number.parseInt(query.offset, 10) || 0, 2147483647));
      const filter = `site_id=$1 AND parent_id IS NOT DISTINCT FROM $2::integer AND name ILIKE $3`;
      const values = [siteId, currentFolderId, `%${search}%`];
      const { rows } = await database.query(`SELECT id, site_id, parent_id, kind, name, mime_type, file_size, created_at, updated_at
        FROM data_storage_entries WHERE ${filter}
        ORDER BY kind DESC, lower(name), id LIMIT ${STORAGE_PAGE_SIZE} OFFSET $4`, [...values, offset]);
      const counts = await database.query(`SELECT count(*)::integer AS total FROM data_storage_entries WHERE ${filter}`, values);
      const stats = await database.query(`SELECT count(*) FILTER (WHERE kind='folder')::integer AS folders,
        count(*) FILTER (WHERE kind='file')::integer AS files,
        COALESCE(sum(file_size), 0)::text AS bytes FROM data_storage_entries WHERE site_id=$1`, [siteId]);
      const breadcrumbs = currentFolderId === null ? [] : (await database.query(`WITH RECURSIVE ancestors AS (
        SELECT id, parent_id, name, 0 AS depth FROM data_storage_entries WHERE id=$1 AND site_id=$2 AND kind='folder'
        UNION ALL SELECT p.id, p.parent_id, p.name, a.depth+1 FROM data_storage_entries p
        JOIN ancestors a ON p.id=a.parent_id WHERE p.site_id=$2 AND p.kind='folder'
      ) SELECT id, name FROM ancestors ORDER BY depth DESC`, [currentFolderId, siteId])).rows;
      return { entries: rows, breadcrumbs, total: counts.rows[0].total, offset, limit: STORAGE_PAGE_SIZE, stats: stats.rows[0] };
    },
    async createFolder(user, body) {
      const siteId = await accessibleSite(user, body.site_id);
      const destination = parentId(body.parent_id);
      const name = nameOf(body.name);
      return transaction(async (client) => {
        await folder(client, siteId, destination, true);
        const { rows } = await client.query(`INSERT INTO data_storage_entries(site_id, parent_id, kind, name, created_by)
          VALUES($1,$2,'folder',$3,$4) RETURNING *`, [siteId, destination, name, user.id]);
        return publicEntry(rows[0]);
      });
    },
    async upload(user, body, file) {
      const siteId = await accessibleSite(user, body.site_id);
      const destination = parentId(body.parent_id);
      if (!file?.buffer) fail(400, 'Select a file to upload.');
      if (file.buffer.length > MAX_STORAGE_FILE_BYTES) fail(413, 'Files must be 50 MB or smaller.');
      const name = nameOf(file.originalname);
      await folder(database, siteId, destination);
      const storageKey = await files.upload(file.buffer, siteId);
      try {
        return await transaction(async (client) => {
          await folder(client, siteId, destination, true);
          const { rows } = await client.query(`INSERT INTO data_storage_entries
            (site_id,parent_id,kind,name,storage_key,mime_type,file_size,created_by)
            VALUES($1,$2,'file',$3,$4,$5,$6,$7) RETURNING *`,
          [siteId, destination, name, storageKey, file.mimetype || 'application/octet-stream', file.buffer.length, user.id]);
          return publicEntry(rows[0]);
        });
      } catch (error) {
        try { await files.remove(storageKey); } catch (cleanupError) { console.error('Data Storage upload cleanup failed:', cleanupError.message); }
        throw error;
      }
    },
    async download(user, siteId, entryId) {
      const item = await entry(user, siteId, entryId);
      if (item.kind !== 'file') fail(400, 'Only files can be downloaded.');
      return { name: item.name, size: item.file_size, stream: await files.open(item.storage_key) };
    },
    async rename(user, siteId, entryId, body) {
      const item = await entry(user, siteId, entryId);
      const name = nameOf(body.name);
      try {
        const { rows } = await database.query(`UPDATE data_storage_entries SET name=$1,updated_at=now()
          WHERE id=$2 AND site_id=$3 RETURNING *`, [name, item.id, item.site_id]);
        if (!rows[0]) fail(404, 'File or folder not found.');
        return publicEntry(rows[0]);
      } catch (error) { mapDatabaseError(error); }
    },
    async remove(user, rawSiteId, rawEntryId) {
      const siteId = await accessibleSite(user, rawSiteId);
      const entryId = id(rawEntryId, 'entry');
      const item = await transaction(async (client) => {
        const { rows } = await client.query('SELECT * FROM data_storage_entries WHERE id=$1 AND site_id=$2 FOR UPDATE', [entryId, siteId]);
        if (!rows[0]) fail(404, 'File or folder not found.');
        if (rows[0].kind === 'folder') {
          const children = await client.query('SELECT 1 FROM data_storage_entries WHERE parent_id=$1 AND site_id=$2 LIMIT 1', [entryId, siteId]);
          if (children.rows.length) fail(409, 'This folder contains files or folders. Empty it before deleting.');
        }
        await client.query('DELETE FROM data_storage_entries WHERE id=$1 AND site_id=$2', [entryId, siteId]);
        return rows[0];
      });
      let cleanupWarning = false;
      if (item.storage_key) {
        try { await files.remove(item.storage_key); }
        catch (error) { cleanupWarning = true; console.error('Data Storage deletion cleanup failed:', error.message); }
      }
      return { message: 'Deleted successfully.', cleanup_warning: cleanupWarning };
    },
  };
}
