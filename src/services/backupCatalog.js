import { createHash } from 'node:crypto';
import { BACKUP_MODULES, moduleForTable } from './backupModules.js';

export const quoteIdentifier = (name) => `"${String(name).replaceAll('"', '""')}"`;
export const publicTable = (name) => `"public".${quoteIdentifier(name)}`;
export const backupFailure = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });

// All database values travel as PostgreSQL text, avoiding JavaScript rounding of
// NUMERIC/BIGINT, timezone conversions, and loss of timestamp microseconds.
export async function configureBackupConnection(client) {
  await client.query(`SET LOCAL search_path = pg_catalog, public`);
  await client.query(`SET LOCAL TIME ZONE 'UTC'`);
  await client.query(`SET LOCAL DateStyle = 'ISO, YMD'`);
  await client.query(`SET LOCAL IntervalStyle = 'postgres'`);
  await client.query(`SET LOCAL bytea_output = 'hex'`);
  await client.query(`SET LOCAL extra_float_digits = 3`);
  await client.query(`SET LOCAL lock_timeout = '10s'`);
  await client.query(`SET LOCAL statement_timeout = '120s'`);
}

export async function readBackupSchema(client) {
  const { rows: relations } = await client.query(`
    SELECT c.relname AS name, c.relkind AS kind, c.relispartition AS partition,
           c.relrowsecurity AS rls, EXISTS(SELECT 1 FROM pg_inherits i WHERE i.inhrelid=c.oid OR i.inhparent=c.oid) AS inherited
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind IN ('r','p','f') ORDER BY c.relname`);
  const unsupported = relations.filter((t) => t.kind !== 'r' || t.partition || t.rls || t.inherited);
  if (unsupported.length) throw backupFailure(`Backup cannot safely cover partitioned, inherited, foreign or row-security tables: ${unsupported.map(t => t.name).join(', ')}. Use a database administrator backup.`, 409);
  if (!relations.length) throw backupFailure('No application tables found. Initialize the application schema first.', 409);
  const { rows: columns } = await client.query(`
    SELECT c.relname AS table_name, a.attname AS name, format_type(a.atttypid,a.atttypmod) AS type,
      a.attnotnull AS "notNull", a.attidentity AS identity, a.attgenerated AS generated,
      pg_get_expr(d.adbin,d.adrelid) AS "default"
    FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid
    JOIN pg_namespace n ON n.oid=c.relnamespace
    LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
    WHERE n.nspname='public' AND c.relkind='r' AND a.attnum>0 AND NOT a.attisdropped
    ORDER BY c.relname,a.attnum`);
  const { rows: constraints } = await client.query(`
    SELECT c.relname AS table_name, k.conname AS name, k.contype AS type,
      pg_get_constraintdef(k.oid,false) AS definition,
      k.condeferrable AS deferrable, k.condeferred AS "initiallyDeferred",
      k.convalidated AS validated,
      r.relname AS "referenceTable", rn.nspname AS "referenceSchema",
      ARRAY(SELECT a.attname FROM unnest(k.conkey) WITH ORDINALITY x(num,ord)
        JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum=x.num ORDER BY x.ord) AS columns
    FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid
    JOIN pg_namespace n ON n.oid=c.relnamespace
    LEFT JOIN pg_class r ON r.oid=k.confrelid LEFT JOIN pg_namespace rn ON rn.oid=r.relnamespace
    WHERE n.nspname='public' ORDER BY c.relname,k.conname`);
  const { rows: triggers } = await client.query(`
    SELECT c.relname AS table_name,t.tgname AS name,t.tgenabled AS enabled,
      pg_get_triggerdef(t.oid,false) AS definition
    FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND NOT t.tgisinternal ORDER BY c.relname,t.tgname`);
  const { rows: indexes } = await client.query(`
    SELECT tablename AS table_name,indexname AS name,indexdef AS definition
    FROM pg_indexes WHERE schemaname='public' ORDER BY tablename,indexname`);
  const { rows: functions } = await client.query(`
    SELECT p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS name,
      pg_get_functiondef(p.oid) AS definition
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.prokind IN ('f','p') ORDER BY 1`);
  const { rows: views } = await client.query(`
    SELECT c.relname AS name,c.relkind AS kind,pg_get_viewdef(c.oid,false) AS definition,
      ARRAY(SELECT DISTINCT dependency.relname FROM pg_rewrite rewrite
        JOIN pg_depend d ON d.classid='pg_rewrite'::regclass AND d.objid=rewrite.oid
        JOIN pg_class dependency ON dependency.oid=d.refobjid AND d.refclassid='pg_class'::regclass
        JOIN pg_namespace dn ON dn.oid=dependency.relnamespace
        WHERE rewrite.ev_class=c.oid AND dependency.oid<>c.oid AND dependency.relkind IN ('v','m')
          AND dn.nspname='public' ORDER BY dependency.relname) AS dependencies
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind IN ('v','m') ORDER BY c.relname`);
  const { rows: enums } = await client.query(`
    SELECT t.typname AS name,e.enumlabel AS label FROM pg_enum e
    JOIN pg_type t ON t.oid=e.enumtypid JOIN pg_namespace n ON n.oid=t.typnamespace
    WHERE n.nspname='public' ORDER BY t.typname,e.enumsortorder`);
  const group = (rows, table) => rows.filter(r => r.table_name === table).map(({ table_name: _, ...row }) => row);
  return {
    tables: relations.map(({ name }) => {
      const keys = group(constraints, name);
      return { name, columns: group(columns, name), constraints: keys,
        primaryKey: keys.find(k => k.type === 'p')?.columns || [],
        triggers: group(triggers, name), indexes: group(indexes, name) };
    }),
    // Function bodies are fingerprinted, never executed from an uploaded file.
    functions: functions.map(({ name, definition }) => ({ name, hash: createHash('sha256').update(definition).digest('hex') })),
    views, enums,
  };
}

export function orderedBackupViews(views) {
  const pending = new Map(views.map(view=>[view.name,view]));
  const result = [];
  while(pending.size) {
    const ready = [...pending.values()].filter(view=>(view.dependencies || []).every(name=>!pending.has(name)));
    if(!ready.length) throw backupFailure('Database views have an unsupported dependency cycle.',409);
    for(const view of ready) { result.push(view);pending.delete(view.name); }
  }
  return result;
}

// Table-level closure in BOTH directions includes children and accounting
// mirrors. Related records may be older than the selected monthly label.
export function selectBackupTables(schema, moduleIds = []) {
  if (!Array.isArray(moduleIds) || moduleIds.some(id => !BACKUP_MODULES.some(m => m.id === id))) {
    throw backupFailure('Choose valid backup modules.');
  }
  if (!moduleIds.length) return schema.tables;
  const names = new Set(schema.tables.filter(t => moduleIds.includes(moduleForTable(t.name))).map(t => t.name));
  if (!names.size) throw backupFailure('The selected modules have no database tables.');
  // These modules also use polymorphic reference_id/source_table links that
  // PostgreSQL cannot express as foreign keys. Keep the finance graph together.
  const finance = new Set(['plots','registry','farmers','commissions','expenses','daybook','cashflow','firms','vendors','imprest','wallet','banking','transfers','tds','misc_income','partner_finance','inventory','construction','documents','audit','document_imprest']);
  let changed = true;
  while (changed) {
    changed = false;
    const financial = schema.tables.some(t => names.has(t.name) && finance.has(moduleForTable(t.name)));
    for (const table of schema.tables) {
      if (financial && finance.has(moduleForTable(table.name)) && !names.has(table.name)) { names.add(table.name); changed = true; }
      for (const fk of table.constraints.filter(k => k.type === 'f' && k.referenceSchema === 'public')) {
        if (names.has(table.name) || names.has(fk.referenceTable)) {
          for (const name of [table.name, fk.referenceTable]) if (!names.has(name)) { names.add(name); changed = true; }
        }
      }
    }
  }
  return schema.tables.filter(t => names.has(t.name));
}

export function summarizeModules(tables) {
  return BACKUP_MODULES.map(m => {
    const entries = tables.filter(t => (t.module || moduleForTable(t.name)) === m.id);
    return { ...m, tables: entries.map(t => t.name), rowCount: entries.reduce((n,t) => n + (t.rows?.length ?? t.rowCount ?? 0),0) };
  }).filter(m => m.tables.length);
}
