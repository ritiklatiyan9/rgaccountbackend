import { randomUUID } from 'node:crypto';
import { encodeBackup, decodeBackup, getBackupLimits, stableStringify, sha256Payload } from './backupArchive.js';
import { captureAttachments, restoreAttachments, validateAttachments } from './backupAttachments.js';
import { backupFailure, configureBackupConnection, publicTable, quoteIdentifier as qi, readBackupSchema, selectBackupTables, summarizeModules, orderedBackupViews } from './backupCatalog.js';
import { moduleForTable } from './backupModules.js';
import { OPERATIONAL_TABLES, neutralizeRestoredJobs } from './backupOperationalState.js';

export const ATTACHMENT_NOTICE = 'Managed local and configured S3 files are included. External links (including Cloudinary) remain links; retain those storage accounts and their originals. Database backups do not contain server environment secrets or external queues.';
const countRows = tables => tables.reduce((n,t) => n + t.rows.length, 0);
const persistedColumns = table => table.columns.filter(c => !c.generated);
const textProjection = columns => columns.map(c => `${qi(c.name)}::text AS ${qi(c.name)}`).join(',');
const validMonth = month => typeof month === 'string' && /^(?:19|20|21)\d{2}-(0[1-9]|1[0-2])$/.test(month);

async function readSequences(client, tableNames = null) {
  const { rows } = await client.query(`
    SELECT c.relname AS name, s.seqstart::text AS start, s.seqincrement::text AS increment,
      s.seqmin::text AS min, s.seqmax::text AS max, s.seqcycle AS cycle,
      t.relname AS "ownerTable", a.attname AS "ownerColumn"
    FROM pg_sequence s JOIN pg_class c ON c.oid=s.seqrelid
    JOIN pg_namespace n ON n.oid=c.relnamespace
    LEFT JOIN pg_depend d ON d.classid='pg_class'::regclass AND d.objid=c.oid AND d.deptype IN ('a','i') AND d.refobjsubid>0
    LEFT JOIN pg_class t ON t.oid=d.refobjid
    LEFT JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum=d.refobjsubid
    WHERE n.nspname='public' ORDER BY c.relname`);
  const result = [];
  for (const sequence of rows) {
    if (tableNames && sequence.ownerTable && !tableNames.has(sequence.ownerTable)) continue;
    const { rows: [state] } = await client.query(`SELECT last_value::text AS "lastValue",is_called AS "isCalled" FROM ${publicTable(sequence.name)}`);
    result.push({ ...sequence, ...state });
  }
  return result;
}

async function readTable(client, table, budget) {
  const columns = persistedColumns(table);
  if (!columns.length) throw backupFailure(`Table ${table.name} has no writable columns.`, 409);
  const rows = [];
  await client.query(`DECLARE backup_rows NO SCROLL CURSOR FOR SELECT ${textProjection(columns)} FROM ${publicTable(table.name)}`);
  try {
    while (true) {
      const result = await client.query('FETCH FORWARD 1000 FROM backup_rows');
      if (!result.rows.length) break;
      for (const row of result.rows) {
        const values = columns.map(c => row[c.name]);
        budget.remaining -= Buffer.byteLength(JSON.stringify(values)) + 1;
        if (budget.remaining < 0) throw backupFailure('The backup exceeds the configured expanded-size limit. Ask your database administrator for a native backup or increase the documented backup limits.', 413);
        rows.push(values);
      }
    }
  } finally { await client.query('CLOSE backup_rows'); }
  return { name: table.name, module: moduleForTable(table.name), columns: columns.map(c => c.name), rows };
}

export async function getBackupCatalog(db) {
  const client = await db.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await configureBackupConnection(client);
    const schema = await readBackupSchema(client);
    const tables = [];
    for (const table of schema.tables) {
      const { rows: [row] } = await client.query(`SELECT count(*)::text AS total FROM ${publicTable(table.name)}`);
      tables.push({ name: table.name, rowCount: Number(row.total) });
    }
    await client.query('COMMIT');
    const modules = summarizeModules(tables).map(module => {
      const included = new Set(selectBackupTables(schema,[module.id]).map(t => t.name));
      const summaries = summarizeModules(tables.filter(t => included.has(t.name)));
      return { ...module, includedModules:summaries.map(m => m.label), includedRowCount:summaries.reduce((sum,m) => sum+m.rowCount,0) };
    });
    return { modules, limits: getBackupLimits(), scope: 'database', attachmentNotice: ATTACHMENT_NOTICE,
      restoreEnabled: process.env.BACKUP_MAINTENANCE_MODE === 'true' };
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
  finally { client.release(); }
}

export async function exportBackup(db, { modules = [], month } = {}) {
  if (!validMonth(month)) throw backupFailure('Use a valid monthly label (YYYY-MM).');
  const client = await db.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await configureBackupConnection(client);
    const schema = await readBackupSchema(client);
    const selected = selectBackupTables(schema, modules);
    for (const table of selected) {
      if (table.constraints.some(c => c.type === 'f' && c.referenceSchema !== 'public')) {
        throw backupFailure(`Table ${table.name} refers to a different schema. A native database backup is required.`, 409);
      }
    }
    // Take relation locks together so DDL cannot change the captured schema.
    await client.query(`LOCK TABLE ${selected.map(t => publicTable(t.name)).join(',')} IN ACCESS SHARE MODE`);
    const budget = { remaining: getBackupLimits().maxExpandedBytes - Buffer.byteLength(JSON.stringify(schema)) - 65536 };
    const tables = [];
    for (const table of selected) tables.push(await readTable(client, table, budget));
    const sequences = await readSequences(client, new Set(selected.map(t => t.name)));
    const attachments = await captureAttachments(tables, { maxBytes: Math.min(200*1024*1024,Math.max(0, Math.floor(budget.remaining * 0.65))) });
    const payload = { backupId: randomUUID(), createdAt: new Date().toISOString(), month,
      kind: modules.length ? 'modules' : 'full', requestedModules: [...new Set(modules)],
      schema: { ...schema, tables: selected }, tables, sequences, attachments };
    const buffer = await encodeBackup(payload);
    await client.query('COMMIT');
    return { buffer, payload, checksum: sha256Payload(payload), filename: `accounts-${month}-${payload.kind}-${payload.backupId.slice(0,8)}.accounts-backup.json.gz` };
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
  finally { client.release(); }
}

export function compatibilityErrors(payload, schema) {
  const errors = [];
  if (!payload.schema || !Array.isArray(payload.schema.tables)) return ['Backup schema metadata is missing.'];
  if (payload.schema.tables.some(t => !t || typeof t !== 'object' || typeof t.name !== 'string' || !Array.isArray(t.columns))) return ['Backup table schema metadata is invalid.'];
  const archived = new Map(payload.schema.tables.map(t => [t.name,t]));
  const current = new Map(schema.tables.map(t => [t.name,t]));
  if (payload.kind === 'full' && payload.requestedModules.length) errors.push('A full backup must include all modules.');
  try {
    const expected = selectBackupTables(schema,payload.kind==='full' ? [] : payload.requestedModules).map(t=>t.name).sort();
    const actual = payload.tables.map(t=>t.name).sort();
    if (stableStringify(expected)!==stableStringify(actual)) errors.push('Backup is missing required related tables. Download a complete module or full backup again.');
  } catch (error) { errors.push(error.message); }
  if (archived.size !== payload.schema.tables.length || archived.size !== payload.tables.length) errors.push('Schema and data table lists differ.');
  for (const table of payload.tables) {
    const target = current.get(table.name);
    const source = archived.get(table.name);
    if (!target || !source) { errors.push(`Unknown or missing table: ${table.name}.`); continue; }
    if (stableStringify(target) !== stableStringify(source)) errors.push(`Schema differs for ${table.name}; use the same application schema/version as the backup.`);
    if (stableStringify(table.columns) !== stableStringify(persistedColumns(target).map(c => c.name))) errors.push(`Column list differs for ${table.name}.`);
    if (table.module !== moduleForTable(table.name)) errors.push(`Incorrect module mapping for ${table.name}.`);
    for (const fk of target.constraints.filter(c => c.type === 'f')) {
      if (fk.referenceSchema !== 'public' || !archived.has(fk.referenceTable)) errors.push(`Missing dependency for ${table.name}: ${fk.referenceTable}.`);
    }
  }
  if (payload.kind === 'full' && (current.size !== archived.size || schema.tables.some(t => !archived.has(t.name)))) errors.push('Full backup does not contain every target table. Initialize a matching schema before restoring.');
  for (const field of ['functions','views','enums']) {
    if (stableStringify(payload.schema[field] ?? null) !== stableStringify(schema[field])) errors.push(`Database ${field} differ from this backup; install the matching application schema/version.`);
  }
  return [...new Set(errors)];
}

function validateSequenceMetadata(archived, current) {
  if (!Array.isArray(archived)) throw backupFailure('Sequence metadata is missing.');
  const names = new Set();
  for (const sequence of archived) {
    if (!sequence || typeof sequence.name !== 'string' || names.has(sequence.name)) throw backupFailure('Invalid or duplicate sequence metadata.');
    names.add(sequence.name);
    const target = current.find(s => s.name === sequence.name);
    if (!target) throw backupFailure(`Unknown sequence ${sequence.name}.`, 409);
    for (const field of ['start','increment','min','max','cycle','ownerTable','ownerColumn']) {
      if (sequence[field] !== target[field]) throw backupFailure(`Sequence definition differs: ${sequence.name}.`, 409);
    }
    if (typeof sequence.lastValue !== 'string' || !/^-?\d+$/.test(sequence.lastValue) || typeof sequence.isCalled !== 'boolean') throw backupFailure('Invalid sequence value.');
    if (BigInt(sequence.lastValue) < BigInt(target.min) || BigInt(sequence.lastValue) > BigInt(target.max)) throw backupFailure(`Sequence value is outside its allowed range: ${sequence.name}.`);
  }
  if (current.some(s => !names.has(s.name))) throw backupFailure('Backup is missing sequence values.', 409);
}

export async function previewBackup(db, buffer) {
  const { payload, checksum } = await decodeBackup(buffer);
  const attachmentSummary = await validateAttachments(payload.attachments);
  const client = await db.connect();
  let errors;
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await configureBackupConnection(client);
    const schema = await readBackupSchema(client);
    errors = compatibilityErrors(payload, schema);
    try { validateSequenceMetadata(payload.sequences, await readSequences(client, new Set(payload.tables.map(t => t.name)))); }
    catch (error) { errors.push(error.message); }
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
  finally { client.release(); }
  const warnings = [
    'This snapshot covers all sites and organizations in its included modules. The monthly label does not filter historical records.',
    'Merge inserts missing rows, skips identical rows and cancels the whole restore on any conflicting record. Validation of live conflicts and foreign keys occurs again during restore.',
    'Stop other applications, booking services and external workers using this database before restoring. External queues and server configuration are not restored.',
    'Restored pending messages are cancelled, imported calendar connections require reconnection, and old login challenges/sessions are invalidated. Review external message queues before restarting workers.',
    'These files contain personal records and account credentials. Keep them in protected storage. Checksums detect damage; only restore backups from a trusted source.',
  ];
  if (payload.kind === 'modules') warnings.push('Related modules are included automatically to preserve accounting links. Use a full backup for a database move.');
  if (payload.attachments?.external?.length) warnings.push(`${payload.attachments.external.length} external file references need their original storage service to remain available.`);
  return { backupId: payload.backupId, createdAt: payload.createdAt, month: payload.month, kind: payload.kind,
    modules: summarizeModules(payload.tables), tables: payload.tables.map(t => ({ name:t.name,rowCount:t.rows.length })),
    totalRows: countRows(payload.tables), compatible: !errors.length, errors, warnings, checksum,
    restoreModes: payload.kind === 'full' ? ['merge','replace'] : ['merge'],
    attachmentNotice: payload.attachments?.notice || ATTACHMENT_NOTICE,
    attachments:{ includedFiles:attachmentSummary.files, externalReferences:attachmentSummary.external, bytes:attachmentSummary.bytes } };
}

async function insertTable(client, source, table, mode) {
  const columns = persistedColumns(table);
  const names = columns.map(c => qi(c.name)).join(',');
  const pk = table.primaryKey;
  let inserted = 0, skipped = 0;
  const insertedIds = [];
  const captureIds = (OPERATIONAL_TABLES.has(table.name) || ['users','user_sessions'].includes(table.name)) && columns.some(c=>c.name==='id');
  const { rows: [existing] } = await client.query(`SELECT count(*)::text AS total FROM ${publicTable(table.name)}`);
  if (mode === 'merge' && !pk.length && existing.total !== '0' && source.rows.length) {
    // No identity means neither deduplication nor conflict detection is safe.
    throw backupFailure(`Cannot merge non-empty table ${table.name} because it has no primary key. Use a full replacement after saving a safety backup.`,409);
  }
  const join = pk.map(name => `t.${qi(name)} IS NOT DISTINCT FROM incoming.${qi(name)}`).join(' AND ');
  // Never resurrect a refresh token, older token version or ended session.
  // Those deliberate restore security changes must not break a repeat merge.
  const securityFields = table.name==='users' ? ['token_version','refresh_token'] : table.name==='user_sessions' ? ['logout_time'] : [];
  const differs = columns.filter(c=>!securityFields.includes(c.name)).map(c => `t.${qi(c.name)}::text IS DISTINCT FROM incoming.${qi(c.name)}::text`).join(' OR ') || 'FALSE';
  for (let offset = 0; offset < source.rows.length; offset += 250) {
    const batch = source.rows.slice(offset,offset+250);
    const projection = columns.map((c,i) => `(v->>${i})::${c.type} AS ${qi(c.name)}`).join(',');
    const cte = `WITH incoming AS (SELECT ${projection} FROM jsonb_array_elements($1::jsonb) v)`;
    if (mode === 'merge' && pk.length) {
      const conflicts = await client.query(`${cte} SELECT 1 FROM incoming JOIN ${publicTable(table.name)} t ON ${join} WHERE ${differs} LIMIT 1`,[JSON.stringify(batch)]);
      if (conflicts.rows.length) throw backupFailure(`Existing data conflicts with backup records in ${table.name}. Nothing was restored. Review the target database or use a full replacement.`,409);
    }
    const filter = mode === 'merge' && pk.length ? ` WHERE NOT EXISTS (SELECT 1 FROM ${publicTable(table.name)} t WHERE ${join})` : '';
    const result = await client.query(`${cte} INSERT INTO ${publicTable(table.name)} (${names}) OVERRIDING SYSTEM VALUE SELECT ${names} FROM incoming${filter}${captureIds ? ' RETURNING id::text AS id' : ''}`,[JSON.stringify(batch)]);
    inserted += result.rowCount;
    skipped += batch.length - result.rowCount;
    if(captureIds) insertedIds.push(...result.rows.map(row=>row.id));
  }
  return { inserted, skipped, insertedIds };
}

function nextSequenceValue(sequence) {
  let next = BigInt(sequence.lastValue) + (sequence.isCalled ? BigInt(sequence.increment) : 0n);
  if (next > BigInt(sequence.max)) {
    if (!sequence.cycle) throw backupFailure(`Sequence ${sequence.name} is exhausted.`,409);
    next = BigInt(sequence.min);
  }
  if (next < BigInt(sequence.min)) {
    if (!sequence.cycle) throw backupFailure(`Sequence ${sequence.name} is exhausted.`,409);
    next = BigInt(sequence.max);
  }
  return next;
}

async function restoreSequences(client, sequences, current, mode) {
  for (const seq of sequences) {
    let next = nextSequenceValue(seq);
    const ascending = BigInt(seq.increment) > 0n;
    if (mode === 'merge') {
      const live = nextSequenceValue(current.find(s => s.name === seq.name));
      next = ascending ? (next > live ? next : live) : (next < live ? next : live);
    }
    if (seq.ownerTable && seq.ownerColumn) {
      const { rows: [row] } = await client.query(`SELECT ${ascending ? 'max' : 'min'}(${qi(seq.ownerColumn)})::text AS edge FROM ${publicTable(seq.ownerTable)}`);
      if (row.edge !== null) {
        const edge = BigInt(row.edge) + BigInt(seq.increment);
        next = ascending ? (next > edge ? next : edge) : (next < edge ? next : edge);
      }
    }
    if (next < BigInt(seq.min) || next > BigInt(seq.max)) throw backupFailure(`No available next ID for sequence ${seq.name}.`,409);
    // ALTER ... RESTART is transactional; setval() is not rolled back on error.
    await client.query(`ALTER SEQUENCE ${publicTable(seq.name)} RESTART WITH ${next.toString()}`);
  }
}

export async function restoreBackup(db, buffer, { mode, checksum, confirmation } = {}) {
  if (!['merge','replace'].includes(mode)) throw backupFailure('Choose merge or replace.');
  if (confirmation !== (mode === 'replace' ? 'REPLACE ALL DATA' : 'RESTORE')) throw backupFailure('The restore confirmation does not match.');
  const decoded = await decodeBackup(buffer);
  if (checksum !== decoded.checksum) throw backupFailure('The selected backup changed. Validate it again before restoring.',409);
  const { payload } = decoded;
  if (mode === 'replace' && payload.kind !== 'full') throw backupFailure('Only a full backup can replace the database.');
  await validateAttachments(payload.attachments);
  const client = await db.connect();
  let committed = false;
  try {
    await client.query('BEGIN');
    await configureBackupConnection(client);
    const lock = await client.query('SELECT pg_try_advisory_xact_lock(734921, 1) AS acquired');
    if (!lock.rows[0].acquired) throw backupFailure('Another restore is running. Try again after it completes.',409);
    let schema = await readBackupSchema(client);
    let errors = compatibilityErrors(payload,schema);
    if (errors.length) throw backupFailure(errors.slice(0,6).join(' '),409);
    // Exclusive locks prevent another writer changing conflict checks or FK
    // relationships while this restore is in progress. No CASCADE is used.
    await client.query(`LOCK TABLE ${schema.tables.map(t => publicTable(t.name)).join(',')} IN ACCESS EXCLUSIVE MODE`);
    schema = await readBackupSchema(client);
    errors = compatibilityErrors(payload,schema);
    if (errors.length) throw backupFailure('Schema changed while preparing restore. Validate the backup again.',409);
    const currentSequences = await readSequences(client,new Set(payload.tables.map(t => t.name)));
    validateSequenceMetadata(payload.sequences,currentSequences);
    const selected = schema.tables.filter(t => payload.tables.some(s => s.name===t.name));
    let versionFloor = 0;
    const users = schema.tables.find(t => t.name === 'users');
    if (mode === 'replace' && users?.columns.some(c => c.name === 'token_version')) {
      const { rows: [row] } = await client.query('SELECT COALESCE(max(token_version),0)::text AS version FROM public.users');
      versionFloor = Number(row.version);
      const saved = payload.tables.find(t => t.name === 'users');
      const role = saved.columns.indexOf('role'), active = saved.columns.indexOf('is_active'), password = saved.columns.indexOf('password');
      if (!saved.rows.some(r => ['admin','super_admin'].includes(r[role]) && (active < 0 || r[active] === 'true' || r[active] === 't') && (password < 0 || r[password]))) {
        throw backupFailure('Backup has no active administrator account. Replacement would lock you out.',409);
      }
    }
    // Preserve exact trigger states, including disabled and replica triggers.
    // Suppress financial mirrors/auditing only inside this locked transaction.
    for (const table of selected) {
      await client.query(`ALTER TABLE ${publicTable(table.name)} DISABLE TRIGGER USER`);
      // Historical messaging/chat rows intentionally predate NOT VALID checks.
      // Preserve that legacy data and the installed validation state. Definitions
      // come exclusively from the locked target catalogue, never uploaded SQL.
      for (const constraint of table.constraints.filter(k => ['c','f'].includes(k.type) && !k.validated)) {
        await client.query(`ALTER TABLE ${publicTable(table.name)} DROP CONSTRAINT ${qi(constraint.name)}`);
      }
      for (const fk of table.constraints.filter(k => k.type==='f' && k.validated)) {
        await client.query(`ALTER TABLE ${publicTable(table.name)} ALTER CONSTRAINT ${qi(fk.name)} DEFERRABLE INITIALLY DEFERRED`);
      }
    }
    await client.query('SET CONSTRAINTS ALL DEFERRED');
    if (mode === 'replace') await client.query(`TRUNCATE TABLE ${selected.map(t => publicTable(t.name)).join(',')}`);
    let inserted = 0, skipped = 0;
    const insertedIds = new Map();
    for (const table of selected) {
      const result = await insertTable(client,payload.tables.find(t => t.name===table.name),table,mode);
      inserted += result.inserted; skipped += result.skipped;
      insertedIds.set(table.name,result.insertedIds);
    }
    // Foreign keys are checked BEFORE resetting constraint definitions. Any
    // missing reference rolls back rows, triggers, constraints and sequences.
    await client.query('SET CONSTRAINTS ALL IMMEDIATE');
    if ((mode==='replace' || insertedIds.get('users')?.length) && users?.columns.some(c => c.name === 'token_version')) {
      const { rows: [row] } = await client.query('SELECT COALESCE(max(token_version),0)::text AS version FROM public.users');
      // Do not reuse the simple backup-version + 1: that may be a token issued
      // after the snapshot (and revoked before this restore).
      const nextVersion = Math.max(versionFloor+1,Number(row.version)+1,Math.floor(Date.now()/1000));
      if (nextVersion >= 2147483647) throw backupFailure('Authentication version limit reached. Rotate the signing secret and reset versions before restoring.',409);
      await client.query(`UPDATE public.users SET token_version=$1${users.columns.some(c=>c.name==='refresh_token') ? ', refresh_token=NULL' : ''}${mode==='merge' ? ' WHERE id::text=ANY($2::text[])' : ''}`,mode==='merge' ? [nextVersion,insertedIds.get('users')] : [nextVersion]);
    }
    if (schema.tables.find(t=>t.name==='user_sessions')?.columns.some(c=>c.name==='logout_time') && (mode==='replace' || insertedIds.get('user_sessions')?.length)) {
      await client.query(`UPDATE public.user_sessions SET logout_time=CURRENT_TIMESTAMP WHERE logout_time IS NULL${mode==='merge' ? ' AND id::text=ANY($1::text[])' : ''}`,mode==='merge' ? [insertedIds.get('user_sessions')] : []);
    }
    const operational = await neutralizeRestoredJobs(client,schema,payload.tables,{mode,insertedIds});
    await restoreSequences(client,payload.sequences,currentSequences,mode);
    for (const table of selected) {
      for (const fk of table.constraints.filter(k => k.type==='f' && k.validated)) {
        await client.query(`ALTER TABLE ${publicTable(table.name)} ALTER CONSTRAINT ${qi(fk.name)} ${fk.deferrable ? `DEFERRABLE INITIALLY ${fk.initiallyDeferred ? 'DEFERRED':'IMMEDIATE'}`:'NOT DEFERRABLE'}`);
      }
      for (const constraint of table.constraints.filter(k => ['c','f'].includes(k.type) && !k.validated)) {
        const definition = /\bNOT VALID\s*$/i.test(constraint.definition) ? constraint.definition : `${constraint.definition} NOT VALID`;
        await client.query(`ALTER TABLE ${publicTable(table.name)} ADD CONSTRAINT ${qi(constraint.name)} ${definition}`);
      }
      for (const trigger of table.triggers) {
        const verb = { O:'ENABLE', D:'DISABLE', R:'ENABLE REPLICA', A:'ENABLE ALWAYS' }[trigger.enabled];
        if (!verb) throw backupFailure('Unsupported trigger state.',409);
        await client.query(`ALTER TABLE ${publicTable(table.name)} ${verb} TRIGGER ${qi(trigger.name)}`);
      }
    }
    for (const view of orderedBackupViews(schema.views).filter(v=>v.kind==='m')) await client.query(`REFRESH MATERIALIZED VIEW ${publicTable(view.name)}`);
    // Files are additive and verified: existing originals are never replaced.
    // On a later DB failure newly copied, unreferenced files can remain; the
    // application database still rolls back in full.
    await restoreAttachments(payload.attachments);
    await client.query('COMMIT');
    committed = true;
    return { message:`Backup restored successfully: ${inserted} records inserted, ${skipped} identical records skipped.`,
      inserted, skipped, tables:selected.length, requiresLogin:mode==='replace', backupId:payload.backupId, ...operational };
  } catch (error) {
    if (!committed) await client.query('ROLLBACK').catch(() => {});
    if (error.statusCode) throw error;
    if (['23503','23505','23514','23502','23P01','22P02','22003'].includes(error.code)) throw backupFailure('Restore cancelled: records conflict with the target database or violate a data constraint. All database changes were rolled back.',409);
    if (['55P03','57014','40P01'].includes(error.code)) throw backupFailure('Restore cancelled because the database is busy or a safety timeout was reached. All database changes were rolled back; stop other writers and try again.',409);
    if (error.code === '42501') throw backupFailure('The database connection must own the application tables and sequences to restore safely. All database changes were rolled back.',403);
    throw error;
  } finally { client.release(); }
}
