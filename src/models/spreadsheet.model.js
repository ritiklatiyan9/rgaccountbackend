import pool from '../config/db.js';
import { applyOpsToSheet, SpreadsheetOpError } from '../utils/spreadsheetOps.js';

const ADMIN_ROLES = new Set(['admin', 'super_admin']);
const VERSION_RETENTION = 50;
const AUTO_CHECKPOINT_MINUTES = 30;

const WORKBOOK_COLUMNS = `
  w.id, w.organization_id, w.site_id, w.name, w.description, w.status,
  w.owner_user_id, w.created_by, w.updated_by, w.version, w.settings,
  w.legacy_file_id, w.created_at, w.updated_at, w.deleted_at,
  s.name AS site_name, owner.name AS owner_name, updater.name AS updated_by_name`;
const WORKBOOK_JOINS = `
  LEFT JOIN sites s ON s.id = w.site_id
  LEFT JOIN users owner ON owner.id = w.owner_user_id
  LEFT JOIN users updater ON updater.id = w.updated_by`;

const sheetRowToJson = (row) => ({ ...row.data, id: row.sheet_key, name: row.name, order: row.sort_order, hide: row.hidden ? 1 : 0 });

const sheetJsonToRow = (sheet, order) => {
  const { id, name, celldata, ...rest } = sheet;
  return {
    sheet_key: id,
    name,
    sort_order: Number.isInteger(sheet.order) ? sheet.order : order,
    hidden: sheet.hide === 1,
    data: { ...rest, celldata: celldata || [] },
    cell_count: (celldata || []).length,
  };
};

async function insertSheets(client, workbookId, sheets) {
  for (let i = 0; i < sheets.length; i += 1) {
    const row = sheetJsonToRow(sheets[i], i);
    await client.query(
      `INSERT INTO spreadsheet_sheets (workbook_id, sheet_key, name, sort_order, hidden, data, cell_count)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [workbookId, row.sheet_key, row.name, row.sort_order, row.hidden, JSON.stringify(row.data), row.cell_count]
    );
  }
}

async function writeVersion(client, { workbookId, version, action, label, userId, sheets }) {
  const snapshot = JSON.stringify(sheets);
  await client.query(
    `INSERT INTO spreadsheet_versions (workbook_id, version, action, label, created_by, snapshot, size_bytes)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7)`,
    [workbookId, version, action, label || null, userId, snapshot, Buffer.byteLength(snapshot)]
  );
  await client.query(
    `DELETE FROM spreadsheet_versions
      WHERE workbook_id = $1
        AND id NOT IN (SELECT id FROM spreadsheet_versions WHERE workbook_id = $1 ORDER BY created_at DESC LIMIT $2)`,
    [workbookId, VERSION_RETENTION]
  );
  await client.query('UPDATE spreadsheet_workbooks SET last_checkpoint_at = NOW() WHERE id = $1', [workbookId]);
}

export async function loadSheets(workbookId, db = pool) {
  const { rows } = await db.query(
    `SELECT sheet_key, name, sort_order, hidden, data
       FROM spreadsheet_sheets WHERE workbook_id = $1 ORDER BY sort_order, id`,
    [workbookId]
  );
  return rows.map(sheetRowToJson);
}

/** Workbook row + the caller's share level + site visibility, tenant-scoped. */
export async function findWorkbookForUser(user, workbookId, { includeDeleted = false, db = pool } = {}) {
  const { rows } = await db.query(
    `SELECT ${WORKBOOK_COLUMNS},
            sh.access_level AS share_level,
            ($3::boolean OR w.site_id IS NULL
              OR EXISTS (SELECT 1 FROM user_sites us WHERE us.user_id = $2 AND us.site_id = w.site_id)) AS site_ok
       FROM spreadsheet_workbooks w
       ${WORKBOOK_JOINS}
       LEFT JOIN spreadsheet_shares sh ON sh.workbook_id = w.id AND sh.user_id = $2
      WHERE w.id = $1 AND w.organization_id = $4
        ${includeDeleted ? '' : 'AND w.deleted_at IS NULL'}
      LIMIT 1`,
    [workbookId, user.id, ADMIN_ROLES.has(user.role), user.organization_id]
  );
  return rows[0] || null;
}

export async function listWorkbooks(user, { siteId = null, search = '', deleted = false, permission = null } = {}, db = pool) {
  const isAdmin = ADMIN_ROLES.has(user.role);
  const params = [user.organization_id, user.id, isAdmin];
  const where = ['w.organization_id = $1', deleted ? 'w.deleted_at IS NOT NULL' : 'w.deleted_at IS NULL'];
  if (!isAdmin) {
    // Sub-admins see: their own workbooks, explicit shares, and (with the excel
    // read permission) org-wide workbooks plus those on their assigned sites.
    const rbacVisible = permission?.can_read === true ? 'TRUE' : 'FALSE';
    where.push(`(
      w.owner_user_id = $2
      OR EXISTS (SELECT 1 FROM spreadsheet_shares sh2 WHERE sh2.workbook_id = w.id AND sh2.user_id = $2)
      OR (${rbacVisible} AND (w.site_id IS NULL OR EXISTS (SELECT 1 FROM user_sites us WHERE us.user_id = $2 AND us.site_id = w.site_id)))
    )`);
  }
  if (siteId) {
    params.push(siteId);
    where.push(`w.site_id = $${params.length}`);
  }
  if (search) {
    params.push(`%${search}%`);
    where.push(`w.name ILIKE $${params.length}`);
  }
  const { rows } = await db.query(
    `SELECT ${WORKBOOK_COLUMNS},
            (SELECT COUNT(*) FROM spreadsheet_sheets ss WHERE ss.workbook_id = w.id)::int AS sheet_count,
            sh.access_level AS share_level,
            ($3::boolean OR w.site_id IS NULL
              OR EXISTS (SELECT 1 FROM user_sites us WHERE us.user_id = $2 AND us.site_id = w.site_id)) AS site_ok
       FROM spreadsheet_workbooks w
       ${WORKBOOK_JOINS}
       LEFT JOIN spreadsheet_shares sh ON sh.workbook_id = w.id AND sh.user_id = $2
      WHERE ${where.join(' AND ')}
      ORDER BY w.updated_at DESC
      LIMIT 500`,
    params
  );
  return rows;
}

export async function createWorkbook({ user, siteId, name, description, sheets, settings, legacyFileId, versionAction }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO spreadsheet_workbooks
         (organization_id, site_id, name, description, owner_user_id, created_by, updated_by, settings, legacy_file_id)
       VALUES ($1,$2,$3,$4,$5,$5,$5,$6::jsonb,$7)
       RETURNING id, version`,
      [user.organization_id, siteId, name, description || null, user.id, JSON.stringify(settings || {}), legacyFileId || null]
    );
    const workbookId = rows[0].id;
    await insertSheets(client, workbookId, sheets);
    if (versionAction) {
      await writeVersion(client, { workbookId, version: rows[0].version, action: versionAction, userId: user.id, sheets });
    }
    await client.query('COMMIT');
    return workbookId;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Apply one batch of client changes under optimistic locking.
 * `changes` = { ops, snapshots, deletedSheetKeys, sheetOrder, settings, name }.
 * Throws SpreadsheetOpError(409) on a version mismatch unless `force`.
 */
export async function applyChanges(workbookId, { baseVersion, force, userId, changes, groupedOps, snapshots, versionLabel }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      'SELECT id, version, last_checkpoint_at FROM spreadsheet_workbooks WHERE id = $1 AND deleted_at IS NULL FOR UPDATE',
      [workbookId]
    );
    const current = rows[0];
    if (!current) throw new SpreadsheetOpError('Workbook not found', 404);
    if (!force && Number.isInteger(baseVersion) && baseVersion !== current.version) {
      const err = new SpreadsheetOpError('This workbook was changed by another user', 409);
      err.serverVersion = current.version;
      throw err;
    }

    const snapshotKeys = new Set(snapshots.map((s) => s.id));
    // 1. Full snapshots win over ops for the same sheet.
    for (const sheet of snapshots) {
      const row = sheetJsonToRow(sheet, sheet.order ?? 0);
      await client.query(
        `INSERT INTO spreadsheet_sheets (workbook_id, sheet_key, name, sort_order, hidden, data, cell_count)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7)
         ON CONFLICT (workbook_id, sheet_key) DO UPDATE
           SET name = EXCLUDED.name, sort_order = EXCLUDED.sort_order, hidden = EXCLUDED.hidden,
               data = EXCLUDED.data, cell_count = EXCLUDED.cell_count, updated_at = NOW()`,
        [workbookId, row.sheet_key, row.name, row.sort_order, row.hidden, JSON.stringify(row.data), row.cell_count]
      );
    }
    // 2. Incremental ops per sheet.
    for (const [sheetKey, ops] of groupedOps) {
      if (snapshotKeys.has(sheetKey)) continue;
      const sheetResult = await client.query(
        'SELECT id, name, sort_order, hidden, data FROM spreadsheet_sheets WHERE workbook_id = $1 AND sheet_key = $2 FOR UPDATE',
        [workbookId, sheetKey]
      );
      const sheetRow = sheetResult.rows[0];
      if (!sheetRow) {
        const err = new SpreadsheetOpError('Sheet no longer exists on the server; a full snapshot is required', 422);
        err.needsSnapshot = [sheetKey];
        throw err;
      }
      const sheet = sheetRowToJson({ ...sheetRow, sheet_key: sheetKey });
      applyOpsToSheet(sheet, ops);
      const row = sheetJsonToRow(sheet, sheetRow.sort_order);
      await client.query(
        `UPDATE spreadsheet_sheets
            SET name = $3, sort_order = $4, hidden = $5, data = $6::jsonb, cell_count = $7, updated_at = NOW()
          WHERE workbook_id = $1 AND sheet_key = $2`,
        [workbookId, sheetKey, row.name, row.sort_order, row.hidden, JSON.stringify(row.data), row.cell_count]
      );
    }
    // 3. Deleted sheets (never delete the last one).
    for (const sheetKey of changes.deletedSheetKeys || []) {
      await client.query(
        `DELETE FROM spreadsheet_sheets WHERE workbook_id = $1 AND sheet_key = $2
           AND (SELECT COUNT(*) FROM spreadsheet_sheets WHERE workbook_id = $1) > 1`,
        [workbookId, sheetKey]
      );
    }
    // 4. Sheet order.
    if (changes.sheetOrder && typeof changes.sheetOrder === 'object') {
      for (const [sheetKey, order] of Object.entries(changes.sheetOrder)) {
        if (!Number.isInteger(order)) continue;
        await client.query(
          'UPDATE spreadsheet_sheets SET sort_order = $3 WHERE workbook_id = $1 AND sheet_key = $2',
          [workbookId, String(sheetKey).slice(0, 64), order]
        );
      }
    }
    // 5. Workbook metadata + version bump.
    const nextVersion = current.version + 1;
    await client.query(
      `UPDATE spreadsheet_workbooks
          SET version = $2, updated_by = $3, updated_at = NOW(),
              name = COALESCE($4, name),
              settings = CASE WHEN $5::jsonb IS NULL THEN settings ELSE $5::jsonb END
        WHERE id = $1`,
      [workbookId, nextVersion, userId, changes.name || null, changes.settings == null ? null : JSON.stringify(changes.settings)]
    );

    // 6. Automatic checkpoint at most once per AUTO_CHECKPOINT_MINUTES, or on demand.
    const lastCheckpoint = current.last_checkpoint_at ? new Date(current.last_checkpoint_at).getTime() : 0;
    const stale = Date.now() - lastCheckpoint > AUTO_CHECKPOINT_MINUTES * 60_000;
    if (versionLabel || stale) {
      const sheets = await loadSheets(workbookId, client);
      await writeVersion(client, {
        workbookId, version: nextVersion, action: versionLabel ? 'MANUAL' : 'AUTOSAVE', label: versionLabel, userId, sheets,
      });
    }
    await client.query('COMMIT');
    return { version: nextVersion };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function replaceSheets(workbookId, sheets, userId, { action, label } = {}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      'SELECT id, version FROM spreadsheet_workbooks WHERE id = $1 FOR UPDATE', [workbookId]
    );
    if (!rows[0]) throw new SpreadsheetOpError('Workbook not found', 404);
    const nextVersion = rows[0].version + 1;
    if (action === 'RESTORE') {
      const before = await loadSheets(workbookId, client);
      await writeVersion(client, { workbookId, version: rows[0].version, action: 'PRE_RESTORE', userId, sheets: before });
    }
    await client.query('DELETE FROM spreadsheet_sheets WHERE workbook_id = $1', [workbookId]);
    await insertSheets(client, workbookId, sheets);
    await client.query(
      'UPDATE spreadsheet_workbooks SET version = $2, updated_by = $3, updated_at = NOW() WHERE id = $1',
      [workbookId, nextVersion, userId]
    );
    if (action) await writeVersion(client, { workbookId, version: nextVersion, action, label, userId, sheets });
    await client.query('COMMIT');
    return { version: nextVersion };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function createManualVersion(workbookId, userId, label) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT version FROM spreadsheet_workbooks WHERE id = $1 FOR UPDATE', [workbookId]);
    if (!rows[0]) throw new SpreadsheetOpError('Workbook not found', 404);
    const sheets = await loadSheets(workbookId, client);
    await writeVersion(client, { workbookId, version: rows[0].version, action: 'MANUAL', label, userId, sheets });
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function listVersions(workbookId, db = pool) {
  const { rows } = await db.query(
    `SELECT v.id, v.version, v.action, v.label, v.size_bytes, v.created_at, v.created_by, u.name AS created_by_name
       FROM spreadsheet_versions v LEFT JOIN users u ON u.id = v.created_by
      WHERE v.workbook_id = $1 ORDER BY v.created_at DESC`,
    [workbookId]
  );
  return rows;
}

export async function getVersion(workbookId, versionId, db = pool) {
  const { rows } = await db.query(
    'SELECT id, version, action, label, snapshot, created_at FROM spreadsheet_versions WHERE workbook_id = $1 AND id = $2',
    [workbookId, versionId]
  );
  return rows[0] || null;
}

export async function updateWorkbookMeta(workbookId, { name, description, status, settings, siteId }, userId, db = pool) {
  const { rows } = await db.query(
    `UPDATE spreadsheet_workbooks
        SET name = COALESCE($2, name),
            description = CASE WHEN $3::text IS NULL THEN description ELSE $3 END,
            status = COALESCE($4, status),
            settings = CASE WHEN $5::jsonb IS NULL THEN settings ELSE $5::jsonb END,
            site_id = CASE WHEN $6::boolean THEN $7::integer ELSE site_id END,
            updated_by = $8, updated_at = NOW()
      WHERE id = $1
      RETURNING id, name, description, status, settings, site_id, version, updated_at`,
    [workbookId, name ?? null, description ?? null, status ?? null,
      settings == null ? null : JSON.stringify(settings), siteId !== undefined, siteId ?? null, userId]
  );
  return rows[0];
}

export async function softDeleteWorkbook(workbookId, userId, db = pool) {
  await db.query(
    'UPDATE spreadsheet_workbooks SET deleted_at = NOW(), updated_by = $2, updated_at = NOW() WHERE id = $1 AND deleted_at IS NULL',
    [workbookId, userId]
  );
}

export async function restoreWorkbook(workbookId, userId, db = pool) {
  await db.query(
    'UPDATE spreadsheet_workbooks SET deleted_at = NULL, updated_by = $2, updated_at = NOW() WHERE id = $1',
    [workbookId, userId]
  );
}

export async function duplicateWorkbook(source, user) {
  const sheets = await loadSheets(source.id);
  return createWorkbook({
    user, siteId: source.site_id, name: `${source.name} (Copy)`, description: source.description,
    sheets, settings: source.settings, versionAction: null,
  });
}

export async function listShares(workbookId, db = pool) {
  const { rows } = await db.query(
    `SELECT sh.id, sh.user_id, sh.access_level, sh.created_at, u.name, u.email, u.role
       FROM spreadsheet_shares sh JOIN users u ON u.id = sh.user_id
      WHERE sh.workbook_id = $1 ORDER BY u.name`,
    [workbookId]
  );
  return rows;
}

export async function upsertShare(workbookId, { userId, accessLevel, createdBy, organizationId }, db = pool) {
  const { rows } = await db.query(
    `INSERT INTO spreadsheet_shares (workbook_id, user_id, access_level, created_by)
     SELECT $1, u.id, $3, $4 FROM users u WHERE u.id = $2 AND u.organization_id = $5 AND u.is_active = TRUE
     ON CONFLICT (workbook_id, user_id) DO UPDATE SET access_level = EXCLUDED.access_level
     RETURNING id, user_id, access_level`,
    [workbookId, userId, accessLevel, createdBy, organizationId]
  );
  return rows[0] || null;
}

export async function deleteShare(workbookId, userId, db = pool) {
  await db.query('DELETE FROM spreadsheet_shares WHERE workbook_id = $1 AND user_id = $2', [workbookId, userId]);
}

export async function listShareCandidates(organizationId, db = pool) {
  const { rows } = await db.query(
    `SELECT id, name, email, role FROM users
      WHERE organization_id = $1 AND is_active = TRUE AND role IN ('admin', 'sub_admin', 'super_admin')
      ORDER BY name LIMIT 500`,
    [organizationId]
  );
  return rows;
}

export async function findByLegacyFile(legacyFileId, organizationId, db = pool) {
  const { rows } = await db.query(
    'SELECT id FROM spreadsheet_workbooks WHERE legacy_file_id = $1 AND organization_id = $2 AND deleted_at IS NULL LIMIT 1',
    [legacyFileId, organizationId]
  );
  return rows[0] || null;
}
