import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { validKey } from './backupAttachments.js';

/** Recovery goes to a NEW private directory; it never writes original S3 keys. */
export async function recoverNativeFiles({ job, storage, directory, signal, maxBytes = 50 * 1024 ** 3 }) {
  if (job.status !== 'completed' || job.verificationStatus !== 'verified' || job.scope !== 'database-files') throw new Error('A verified backup containing files is required.');
  const root = path.resolve(directory);
  const manifestStream = await storage.read(job.manifestKey, { signal });
  const chunks = []; let length = 0;
  for await (const chunk of manifestStream) {
    length += chunk.length;
    if (length > 65536) { manifestStream.destroy(); throw new Error('Backup recovery manifest is oversized.'); }
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks);
  if (createHash('sha256').update(bytes).digest('hex') !== job.metadata?.manifestChecksum) throw new Error('Backup recovery manifest checksum failed.');
  const manifest = JSON.parse(bytes.toString('utf8'));
  if (manifest.format !== 'rgaccounts-native-backup' || manifest.version !== 1 || manifest.jobId !== job.id
    || manifest.files?.manifestKey !== `${job.artifactPrefix}files.ndjson` || !Number.isSafeInteger(manifest.files.bytes)
    || manifest.files.bytes < 0 || manifest.files.bytes > maxBytes || !Number.isSafeInteger(manifest.files.count)
    || manifest.files.count < 0) throw new Error('Invalid or oversized file recovery manifest.');
  await storage.verify(manifest.files.manifestKey, { bytes: manifest.files.manifestBytes, checksum: manifest.files.manifestChecksum }, { signal });
  await fs.mkdir(root, { mode: 0o700 }); // EEXIST prevents merging into existing data.
  await fs.writeFile(path.join(root, 'RECOVERY_INCOMPLETE'), 'Recovery has not finished. Do not switch application storage to this directory.\n', { mode: 0o600, flag: 'wx' });
  let count = 0; let totalBytes = 0;
  const stream = await storage.read(manifest.files.manifestKey, { signal });
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const indexHash = createHash('sha256'); let indexBytes = 0;
  let pending = '';
  async function recover(line) {
    const file = JSON.parse(line);
    if (!['local', 's3'].includes(file.storage) || !validKey(file.key)
      || (file.storage === 's3' && !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(file.bucket || ''))
      || !new RegExp(`^${job.artifactPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}files/[a-f0-9]{64}$`).test(file.artifactKey || '')
      || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || !/^[a-f0-9]{64}$/.test(file.checksum || '')) throw new Error('Unsafe file recovery entry.');
    totalBytes += file.bytes;
    if (totalBytes > maxBytes || totalBytes > manifest.files.bytes || count >= manifest.files.count) throw new Error('File recovery exceeds the declared size or count.');
    const filename = path.join(root, file.storage, ...(file.storage === 's3' ? [file.bucket] : []), file.key);
    await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
    await storage.verify(file.artifactKey, file, { signal, consumer: createWriteStream(filename, { flags: 'wx', mode: 0o600 }) });
    count++;
  }
  try {
    for await (const chunk of stream) {
      indexHash.update(chunk); indexBytes += chunk.length;
      pending += decoder.decode(chunk, { stream: true });
      let newline;
      while ((newline = pending.indexOf('\n')) >= 0) {
        if (newline > 32768) throw new Error('File recovery entry is oversized.');
        await recover(pending.slice(0, newline)); pending = pending.slice(newline + 1);
      }
      if (pending.length > 32768) throw new Error('File recovery entry is oversized.');
    }
    pending += decoder.decode();
    if (indexBytes !== manifest.files.manifestBytes || indexHash.digest('hex') !== manifest.files.manifestChecksum) throw new Error('File recovery inventory changed after verification.');
    if (pending || count !== manifest.files.count || totalBytes !== manifest.files.bytes) throw new Error('File recovery manifest is incomplete.');
    await fs.writeFile(path.join(root, 'RECOVERY_VERIFIED.json'), JSON.stringify({ jobId: job.id, count, bytes: totalBytes, verifiedAt: new Date().toISOString() }), { flag: 'wx', mode: 0o600 });
    await fs.unlink(path.join(root, 'RECOVERY_INCOMPLETE'));
    return { count, bytes: totalBytes };
  } finally { stream.destroy(); }
}
