import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import pg from 'pg';

const DEFAULT_MAX_BYTES = 200 * 1024 * 1024;
const STORAGE_COLUMNS = new Set(['file_path', 'storage_key', 's3_key', 'photo_key', 'return_photo_key', 'outcome_photo_key']);
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const fail = (message) => { const error = new Error(message); error.status = 400; error.statusCode = 400; throw error; };
const maximumBytes = (value) => {
  if (value === undefined) return DEFAULT_MAX_BYTES;
  if (!Number.isSafeInteger(value) || value < 0) fail('Attachment size limit is invalid.');
  return value;
};

function storageProfiles(env) {
  return [
    { name: 'current', bucket: env.AWS_S3_BUCKET_NAME || env.AWS_S3_BUCKET, region: env.AWS_REGION || 'ap-south-1', accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY },
    { name: 'legacy', bucket: env.LEGACY_AWS_S3_BUCKET_NAME || env.LEGACY_AWS_S3_BUCKET, region: env.LEGACY_AWS_REGION || env.AWS_REGION || 'ap-south-1', accessKeyId: env.LEGACY_AWS_ACCESS_KEY_ID, secretAccessKey: env.LEGACY_AWS_SECRET_ACCESS_KEY },
  ].filter((profile) => profile.bucket);
}

export function validKey(key) {
  return typeof key === 'string' && key.length > 0 && Buffer.byteLength(key) <= 1024
    && !/[\\\x00-\x1f\x7f]/.test(key) && !key.startsWith('/')
    && key.split('/').every((segment) => segment !== '.' && segment !== '..' && segment !== '');
}

export function validLocalKey(key) {
  return validKey(key) && /^(excel|kyc_documents|data_storage)\/[^/]+$/.test(key);
}

function s3Source(value, profiles) {
  let url;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
  for (const profile of profiles) {
    const prefix = `${profile.bucket}.s3`;
    if (!url.hostname.startsWith(prefix)) continue;
    const suffix = url.hostname.slice(prefix.length);
    const match = suffix.match(/^[.-]([a-z]{2}(?:-[a-z]+)+-\d)\.amazonaws\.com$/);
    if (suffix !== '.amazonaws.com' && !match) continue;
    let key;
    try { key = decodeURIComponent(url.pathname.slice(1)); } catch { fail('A stored S3 attachment has an invalid URL.'); }
    if (!validKey(key)) fail('A stored S3 attachment has an unsafe object key.');
    return { storage: 's3', bucket: profile.bucket, key, region: match?.[1] || profile.region };
  }
  return null;
}

function localUrlKey(value, table, column) {
  if (value.startsWith('local::')) return `${table === 'data_storage_entries' ? 'data_storage' : table === 'excel_files' || column === 's3_key' ? 'excel' : 'kyc_documents'}/${value.slice(7)}`;
  let pathname = value;
  if (/^https?:\/\//i.test(value)) {
    let url;
    try { url = new URL(value); } catch { return null; }
    // The application's local storage URLs are generated with localhost.
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return null;
    pathname = url.pathname;
  }
  const match = pathname.match(/^\/uploads\/(excel|kyc_documents)\/([^/?#]+)$/);
  if (!match) return null;
  try { return `${match[1]}/${decodeURIComponent(match[2])}`; } catch { fail('A stored local attachment has an invalid URL.'); }
}

/** Find references without fetching any URL supplied by a backup or database row. */
export function attachmentReferences(tables, { env = process.env, referencesOnly=false } = {}) {
  const profiles = storageProfiles(env);
  const files = new Map();
  const external = new Map();
  const add = (reference) => files.set(`${reference.storage}:${reference.bucket || ''}:${reference.key}`, reference);
  function visit(value, column, table, depth = 0) {
    if (value == null || depth > 20) return;
    if (Array.isArray(value)) { for (const item of value) visit(item, column, table, depth + 1); return; }
    if (typeof value === 'object') { for (const [key, item] of Object.entries(value)) visit(item, key, table, depth + 1); return; }
    if (typeof value !== 'string' || !value.trim()) return;
    const text = value.trim();
    if (/^[{[]/.test(text)) {
      let parsed;
      try { parsed = JSON.parse(text); } catch {
        if (text.startsWith('{') && text.endsWith('}')) {
          try { parsed = pg.types.getTypeParser(1009)(text); } catch { /* ordinary text */ }
        }
      }
      if (parsed && typeof parsed === 'object') { visit(parsed, column, table, depth + 1); return; }
    }
    const localKey = localUrlKey(text, table, column);
    if (localKey) {
      if (!validLocalKey(localKey)) fail('A stored local attachment has an unsafe filename.');
      add({ storage: 'local', key: localKey }); return;
    }
    if (/^https?:\/\//i.test(text)) {
      const source = s3Source(text, profiles);
      if (source) add(source);
      else external.set(text, { url: text, reason: 'External file URL retained in the data; file bytes are not included. Keep the original storage accessible.' });
      return;
    }
    if (STORAGE_COLUMNS.has(column) && !text.startsWith('data:')) {
      if (!validKey(text)) fail('A stored attachment has an unsafe object key.');
      const profile = profiles.find((candidate) => candidate.name === 'current');
      if (!profile) {
        if (referencesOnly) { add({storage:'unconfigured',key:text}); return; }
        fail('Referenced S3 attachments cannot be backed up until the application storage bucket is configured.');
      }
      add({ storage: 's3', bucket: profile.bucket, key: text, region: profile.region });
    }
  }
  const input = Array.isArray(tables) ? tables : Object.entries(tables || {}).map(([name, table]) => ({ ...table, name }));
  for (const table of input) {
    for (const row of table.rows || []) {
      if (Array.isArray(row)) (table.columns || []).forEach((column, index) => visit(row[index], typeof column === 'string' ? column : column.name, table.name));
      else for (const [column, value] of Object.entries(row || {})) visit(value, column, table.name);
    }
  }
  return { files: [...files.values()], external: [...external.values()] };
}

export async function localDirectory(key, cwd, create) {
  if (!validLocalKey(key)) fail('Backup contains an unsafe local attachment filename.');
  const root = await fs.realpath(cwd);
  const [folder] = key.split('/');
  let directory = root;
  for (const segment of ['uploads', folder]) {
    directory = path.join(directory, segment);
    if (create) await fs.mkdir(directory, { mode: 0o700 }).catch((error) => { if (error.code !== 'EEXIST') throw error; });
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('Backup attachment directory must be a real local directory.');
  }
  return directory;
}

async function readLocal(key, cwd, limit) {
  const directory = await localDirectory(key, cwd, false);
  const handle = await fs.open(path.join(directory, key.split('/')[1]), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) fail('Referenced local attachment is not a regular file.');
    if (stat.size > limit) fail('Attachments exceed the backup size limit.');
    return await readBounded(handle.createReadStream({ autoClose: false }), limit);
  } finally { await handle.close(); }
}

async function readBounded(body, limit) {
  if (!body || typeof body[Symbol.asyncIterator] !== 'function') fail('Attachment storage returned an unreadable file.');
  const chunks = []; let length = 0;
  try {
    for await (const chunk of body) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      length += bytes.length;
      if (length > limit) fail('Attachments exceed the backup size limit.');
      chunks.push(bytes);
    }
    return Buffer.concat(chunks, length);
  } catch (error) { body.destroy?.(); throw error; }
}

export function objectSender(options) {
  if (options.s3Send) return options.s3Send;
  const clients = new Map(); const profiles = storageProfiles(options.env || process.env);
  return async (source, command) => {
    const profile = profiles.find((candidate) => candidate.bucket === source.bucket);
    if (!profile) fail('The backup references an S3 bucket that is not configured on this installation.');
    const id = `${source.bucket}:${source.region}`;
    if (!clients.has(id)) clients.set(id, new S3Client({
      region: source.region,
      ...(profile.accessKeyId && profile.secretAccessKey ? { credentials: { accessKeyId: profile.accessKeyId, secretAccessKey: profile.secretAccessKey } } : {}),
    }));
    return clients.get(id).send(command, { abortSignal: AbortSignal.timeout(options.timeoutMs || 30000) });
  };
}

async function readS3(file, send, limit) {
  const object = await send(file, new GetObjectCommand({ Bucket: file.bucket, Key: file.key }));
  if (object.ContentLength > limit) { object.Body?.destroy?.(); fail('Attachments exceed the backup size limit.'); }
  return { bytes: await readBounded(object.Body, limit), contentType: object.ContentType || 'application/octet-stream' };
}

export async function captureAttachments(tables, options = {}) {
  const refs = attachmentReferences(tables, {...options,referencesOnly:options.includeFiles===false});
  if (options.includeFiles===false) return {
    version:1,files:[],external:refs.external,filesIncluded:false,managedReferenceCount:refs.files.length,
    notice:'This archive includes database records and file links only. Original uploaded files are not included. Keep the original local/S3 storage or back up those files separately before moving databases.',
  };
  const limit = maximumBytes(options.maxBytes); const send = objectSender(options);
  const files = []; let total = 0;
  options.onProgress?.({stage:'attachments',files:0,totalFiles:refs.files.length});
  for (const file of refs.files) {
    let bytes; let contentType;
    try {
      if (file.storage === 'local') bytes = await readLocal(file.key, options.cwd || process.cwd(), limit - total);
      else ({ bytes, contentType } = await readS3(file, send, limit - total));
    } catch (error) {
      if (error.statusCode) throw error;
      const cause = error.code || error.name || 'storage error';
      fail(`Cannot back up referenced attachment ${file.key} (${cause}). Restore storage access, or choose records and file links only and preserve the original files separately.`);
    }
    total += bytes.length;
    files.push({ ...file, data: bytes.toString('base64'), sha256: sha256(bytes), ...(contentType ? { contentType } : {}) });
    options.onProgress?.({stage:'attachments',files:files.length,totalFiles:refs.files.length});
  }
  return {
    version: 1, files, external: refs.external,
    notice: refs.external.length
      ? 'Referenced local and configured S3 files are included. External URLs (including Cloudinary) retain their links only and require the original storage. S3 files restore to the same configured bucket.'
      : 'Referenced local and configured S3 files are included. S3 files restore to the same configured bucket; environment configuration and storage credentials are not included.',
  };
}

/** Validate fully before database changes or attachment writes. */
export function validateAttachments(attachments, options = {}) {
  if (!attachments || attachments.version !== 1 || !Array.isArray(attachments.files) || !Array.isArray(attachments.external)) fail('Backup attachment manifest is invalid.');
  if (attachments.filesIncluded!==undefined && (attachments.filesIncluded!==false || attachments.files.length!==0 || !Number.isSafeInteger(attachments.managedReferenceCount) || attachments.managedReferenceCount<0 || attachments.managedReferenceCount>100000)) fail('Backup file-link manifest is invalid.');
  if (attachments.files.length > 100000 || attachments.external.length > 100000) fail('Backup contains too many attachment records.');
  const limit = maximumBytes(options.maxBytes); const seen = new Set(); let bytes = 0;
  const profiles = storageProfiles(options.env || process.env);
  for (const file of attachments.files) {
    if (!file || typeof file !== 'object' || !['local', 's3'].includes(file.storage)) fail('Backup attachment storage type is invalid.');
    if (file.storage === 'local' ? !validLocalKey(file.key) : !validKey(file.key)) fail('Backup contains an unsafe attachment filename.');
    if (file.storage === 's3') {
      if (typeof file.bucket !== 'string' || !profiles.some((profile) => profile.bucket === file.bucket)) fail('S3 attachment bucket differs from this installation. Configure the original bucket before restoring.');
      if (typeof file.region !== 'string' || !/^[a-z]{2}(?:-[a-z]+)+-\d$/.test(file.region)) fail('Backup attachment region is invalid.');
      if (file.contentType != null && (typeof file.contentType !== 'string' || file.contentType.length > 255 || /[\r\n\x00]/.test(file.contentType))) fail('Backup attachment content type is invalid.');
    }
    const identity = `${file.storage}:${file.bucket || ''}:${file.key}`;
    if (seen.has(identity)) fail('Backup contains duplicate attachment destinations.');
    seen.add(identity);
    // A repeated four-character regex group can overflow V8's regex stack on
    // multi-megabyte files. A flat scan plus canonical re-encoding stays bounded.
    if (typeof file.data !== 'string' || file.data.length > Math.ceil((limit - bytes) / 3) * 4 || file.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(file.data)) fail('Backup attachment data is invalid or exceeds the size limit.');
    const decoded = Buffer.from(file.data, 'base64'); bytes += decoded.length;
    if (decoded.toString('base64') !== file.data) fail('Backup attachment base64 data is not canonical.');
    if (bytes > limit) fail('Attachments exceed the backup size limit.');
    if (typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(file.sha256) || sha256(decoded) !== file.sha256) fail('Backup attachment checksum does not match.');
  }
  for (const item of attachments.external) {
    if (!item || typeof item.url !== 'string' || item.url.length > 16384 || !/^https?:\/\//i.test(item.url) || typeof item.reason !== 'string' || item.reason.length > 2000) fail('Backup external attachment reference is invalid.');
  }
  return { files: attachments.files.length, external: attachments.external.length, bytes };
}

async function restoreLocal(file, bytes, cwd) {
  const directory = await localDirectory(file.key, cwd, true);
  const destination = path.join(directory, file.key.split('/')[1]);
  const temporary = path.join(directory, `.backup-${crypto.randomUUID()}.tmp`);
  await fs.writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
  try {
    try { await fs.link(temporary, destination); return true; }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    const existing = await readLocal(file.key, cwd, bytes.length);
    if (!existing.equals(bytes)) fail(`Attachment ${file.key} already exists with different contents. No existing file was overwritten.`);
    return false;
  } finally { await fs.unlink(temporary).catch(() => {}); }
}

const isMissingObject = (error) => error?.name === 'NoSuchKey' || error?.name === 'NotFound' || error?.$metadata?.httpStatusCode === 404;

async function restoreS3(file, bytes, send) {
  const checkExisting = async () => {
    try {
      const existing = await readS3(file, send, bytes.length);
      if (!existing.bytes.equals(bytes)) fail(`Attachment ${file.key} already exists with different contents. No existing file was overwritten.`);
      return true;
    } catch (error) { if (isMissingObject(error)) return false; throw error; }
  };
  if (await checkExisting()) return false;
  try {
    await send(file, new PutObjectCommand({ Bucket: file.bucket, Key: file.key, Body: bytes, ContentType: file.contentType || 'application/octet-stream', IfNoneMatch: '*' }));
    return true;
  } catch (error) {
    if (error?.$metadata?.httpStatusCode === 412 && await checkExisting()) return false;
    throw error;
  }
}

/** Add missing files; identical existing files are reused and never overwritten. */
export async function restoreAttachments(attachments, options = {}) {
  const summary = validateAttachments(attachments, options);
  const send = objectSender(options); let created = 0;
  for (const file of attachments.files) {
    const bytes = Buffer.from(file.data, 'base64');
    if (file.storage === 'local' ? await restoreLocal(file, bytes, options.cwd || process.cwd()) : await restoreS3(file, bytes, send)) created++;
  }
  return { ...summary, created, reused: summary.files - created };
}
