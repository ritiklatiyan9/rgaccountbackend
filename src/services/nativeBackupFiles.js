import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { attachmentReferences, localDirectory, objectSender } from './backupAttachments.js';

const quote = value => `"${String(value).replaceAll('"', '""')}"`;
const check = signal => { if (signal?.aborted) throw signal.reason || new Error('Backup cancelled.'); };

/** Only enabled after operations guarantees immutable object keys and delayed deletion.
 * This does not pretend a PostgreSQL snapshot makes mutable storage transactional.
 */
export async function captureNativeAttachments({ snapshot, metadata, job, config, storage, signal, progress }) {
  const send = objectSender({ timeoutMs: config.timeoutMs, signal });
  const { rows: columns } = await snapshot.query(`SELECT n.nspname AS schema,c.relname AS name,a.attname AS column
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid
    WHERE n.nspname='public' AND c.relkind IN ('r','p') AND a.attnum>0 AND NOT a.attisdropped
    ORDER BY c.oid,a.attnum`);
  const tables = new Map();
  for (const column of columns) {
    const id = `${column.schema}.${column.name}`;
    if (!tables.has(id)) tables.set(id, { schema: column.schema, name: column.name, columns: [] });
    tables.get(id).columns.push(column.column);
  }
  let count = 0; let bytes = 0; let externalReferences = 0;
  for (const table of tables.values()) {
    check(signal);
    // Parent partition scans already include children; duplicates are deduplicated durably.
    // Reject oversized rows before materializing values in Node. A bounded single-row cursor
    // protects against unusually wide records as well as total database size.
    await snapshot.query(`DECLARE backup_files NO SCROLL CURSOR FOR SELECT CASE WHEN octet_length(to_jsonb(t)::text)>1048576 THEN NULL ELSE to_jsonb(t) END AS record FROM ${quote(table.schema)}.${quote(table.name)} t`);
    try {
      while (true) {
        check(signal);
        const { rows } = await snapshot.query('FETCH FORWARD 1 FROM backup_files');
        if (!rows.length) break;
        if (!rows[0].record) throw new Error('An attachment scan row exceeds 1 MiB. Use database-only backup and protect file storage separately.');
        const row = rows[0].record;
        const refs = attachmentReferences([{ name: table.name, columns: table.columns, rows: [table.columns.map(column => row[column])] }]);
        externalReferences += refs.external.length;
        for (const file of refs.files) {
          check(signal);
          const fileId = createHash('sha256').update(JSON.stringify([file.storage, file.bucket || '', file.key])).digest('hex');
          const inserted = await metadata.query(`INSERT INTO backup_control.files(job_id,attempt,file_id) VALUES($1,$2,$3)
            ON CONFLICT DO NOTHING RETURNING file_id`, [job.id, job.attempt, fileId]);
          if (!inserted.rows.length) continue;
          const key = `${job.artifactPrefix}files/${fileId}`;
          let result; let sourceVersion = null; let contentType = 'application/octet-stream';
          if (file.storage === 's3') {
            const source = await send(file, new GetObjectCommand({ Bucket: file.bucket, Key: file.key }));
            sourceVersion = source.VersionId || null;
            contentType = source.ContentType || contentType;
            result = await storage.upload(key, source.Body, { signal, contentType });
            if (Number(source.ContentLength) !== result.bytes) throw new Error('Source attachment size changed during backup.');
          } else {
            const directory = await localDirectory(file.key, config.localRoot, false);
            const handle = await fs.open(path.join(directory, file.key.split('/')[1]), constants.O_RDONLY | constants.O_NOFOLLOW);
            try {
              const before = await handle.stat();
              if (!before.isFile()) throw new Error('A referenced attachment is not a regular file.');
              result = await storage.upload(key, handle.createReadStream({ autoClose: false }), { signal, contentType });
              const after = await handle.stat();
              if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || result.bytes !== before.size) throw new Error('Local attachment changed during backup.');
            } finally { await handle.close(); }
          }
          await storage.verify(key, result, { signal });
          const entry = { ...file, sourceVersion, contentType, artifactKey: key, ...result };
          await metadata.query('UPDATE backup_control.files SET metadata=$4::jsonb WHERE job_id=$1 AND attempt=$2 AND file_id=$3', [job.id, job.attempt, fileId, JSON.stringify(entry)]);
          count++; bytes += result.bytes;
          progress({ stage: 'attachments', files: count, fileBytes: bytes });
        }
      }
    } finally { await snapshot.query('CLOSE backup_files'); }
  }
  const manifestKey = `${job.artifactPrefix}files.ndjson`;
  async function* entries() {
    let last = '';
    while (true) {
      check(signal);
      const { rows } = await metadata.query(`SELECT file_id,metadata FROM backup_control.files
        WHERE job_id=$1 AND attempt=$2 AND file_id>$3 ORDER BY file_id LIMIT 100`, [job.id, job.attempt, last]);
      if (!rows.length) break;
      for (const row of rows) { yield `${JSON.stringify(row.metadata)}\n`; last = row.file_id; }
    }
  }
  const manifest = await storage.upload(manifestKey, Readable.from(entries()), { signal, contentType: 'application/x-ndjson' });
  await storage.verify(manifestKey, manifest, { signal });
  return { count, bytes, manifestKey, manifestChecksum: manifest.checksum, manifestBytes: manifest.bytes, externalReferences,
    notice: 'Managed originals are copied. External links require separate recovery. File keys must remain immutable and retained until capture finishes.' };
}
