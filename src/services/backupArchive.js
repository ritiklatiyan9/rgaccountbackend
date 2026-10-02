import { createHash, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { gzip, gunzip } from 'node:zlib';

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);
const UNSAFE_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const MIB = 1024 * 1024;
const MAX_DEPTH = 64;

export const BACKUP_FORMAT = 'rgaccounts-backup';
export const BACKUP_VERSION = 1;

export class BackupError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'BackupError';
    this.status = status;
    this.statusCode = status;
  }
}

function megabytes(value, fallback, ceiling) {
  const parsed = Number(value);
  return (Number.isInteger(parsed) && parsed >= 1 ? Math.min(parsed, ceiling) : fallback) * MIB;
}

// Bound configuration as well as uploads: accidentally large environment values
// must not disable the decompression-bomb protection.
export function getBackupLimits() {
  return {
    maxUploadBytes: megabytes(process.env.BACKUP_MAX_UPLOAD_MB, 100, 500),
    maxExpandedBytes: megabytes(process.env.BACKUP_MAX_EXPANDED_MB, 100, 1024),
  };
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Canonical JSON retains exact strings and sorts object keys only, never rows. */
export function stableStringify(value) {
  const ancestors = new Set();
  function encode(item, depth) {
    if (depth > MAX_DEPTH) throw new BackupError('Backup data exceeds the maximum nesting depth.');
    if (item === null) return 'null';
    if (typeof item === 'string' || typeof item === 'boolean') return JSON.stringify(item);
    if (typeof item === 'number' && Number.isFinite(item)) return JSON.stringify(item);
    if (typeof item !== 'object') throw new BackupError('Backup data must contain only valid JSON values.');
    if (ancestors.has(item)) throw new BackupError('Backup data contains a circular reference.');
    const prototype = Object.getPrototypeOf(item);
    if (!Array.isArray(item) && prototype !== Object.prototype && prototype !== null) {
      throw new BackupError('Backup data must contain plain JSON objects.');
    }
    ancestors.add(item);
    try {
      if (Array.isArray(item)) {
        const values = [];
        for (let index = 0; index < item.length; index += 1) values.push(encode(item[index], depth + 1));
        return `[${values.join(',')}]`;
      }
      const values = [];
      for (const key of Object.keys(item).sort()) {
        if (UNSAFE_KEYS.has(key)) throw new BackupError(`Backup data contains a prohibited object key: ${key}.`);
        values.push(`${JSON.stringify(key)}:${encode(item[key], depth + 1)}`);
      }
      return `{${values.join(',')}}`;
    } finally {
      ancestors.delete(item);
    }
  }
  return encode(value, 0);
}

export function sha256Payload(payload) {
  return createHash('sha256').update(stableStringify(payload), 'utf8').digest('hex');
}

function identifier(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value);
}

function uniqueStrings(values, label) {
  if (!Array.isArray(values) || values.some(value => !identifier(value))) {
    throw new BackupError(`Backup ${label} must be an array of nonempty names.`);
  }
  if (new Set(values).size !== values.length) throw new BackupError(`Backup contains duplicate ${label}.`);
}

function validatePayload(payload) {
  if (!isObject(payload)) throw new BackupError('Backup payload must be an object.');
  if (typeof payload.backupId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(payload.backupId)) {
    throw new BackupError('Backup ID must be a UUID.');
  }
  if (typeof payload.createdAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(payload.createdAt)
      || !Number.isFinite(Date.parse(payload.createdAt)) || new Date(payload.createdAt).toISOString() !== payload.createdAt) {
    throw new BackupError('Backup creation time must be a valid UTC ISO timestamp.');
  }
  if (typeof payload.month !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(payload.month)) {
    throw new BackupError('Backup month must use YYYY-MM.');
  }
  if (!['full', 'modules'].includes(payload.kind)) throw new BackupError('Backup kind must be full or modules.');
  uniqueStrings(payload.requestedModules, 'requested modules');
  if (payload.kind === 'modules' && payload.requestedModules.length === 0) {
    throw new BackupError('A module backup must identify at least one requested module.');
  }
  if (!isObject(payload.schema) || !Array.isArray(payload.schema.tables)) throw new BackupError('Backup schema must contain a tables array.');
  if (!Array.isArray(payload.tables)) throw new BackupError('Backup tables must be an array.');
  if (!Array.isArray(payload.sequences)) throw new BackupError('Backup sequences must be an array.');
  if (payload.attachments !== undefined && !isObject(payload.attachments)) throw new BackupError('Backup attachments must be an object.');

  const names = new Set();
  for (const table of payload.tables) {
    if (!isObject(table) || !identifier(table.name) || !identifier(table.module)) throw new BackupError('Backup contains an invalid table or module name.');
    if (names.has(table.name)) throw new BackupError(`Backup contains duplicate table: ${table.name}.`);
    names.add(table.name);
    uniqueStrings(table.columns, `columns in ${table.name}`);
    if (table.columns.length === 0) throw new BackupError(`Backup table ${table.name} has no columns.`);
    if (!Array.isArray(table.rows)) throw new BackupError(`Backup rows for ${table.name} must be an array.`);
    for (const row of table.rows) {
      if (!Array.isArray(row) || row.length !== table.columns.length) throw new BackupError(`Backup row width does not match columns in ${table.name}.`);
      for (const cell of row) {
        if (cell !== null && typeof cell !== 'string') {
          throw new BackupError(`Backup values in ${table.name} must be strings or null to preserve database precision.`);
        }
      }
    }
  }
}

export async function encodeBackup(payload) {
  validatePayload(payload);
  const canonical = stableStringify(payload);
  const checksum = createHash('sha256').update(canonical, 'utf8').digest('hex');
  const envelope = `{"format":"${BACKUP_FORMAT}","version":${BACKUP_VERSION},"checksum":"${checksum}","payload":${canonical}}`;
  const limits = getBackupLimits();
  if (Buffer.byteLength(envelope, 'utf8') > limits.maxExpandedBytes) {
    throw new BackupError('Backup exceeds the expanded size limit. Download smaller module backups or increase the configured backup limit.', 413);
  }
  const compressed = await gzipAsync(envelope);
  if (compressed.length > limits.maxUploadBytes) {
    throw new BackupError('Backup exceeds the upload size limit. Download smaller module backups or increase the configured backup limit.', 413);
  }
  return compressed;
}

export async function decodeBackup(buffer) {
  const limits = getBackupLimits();
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new BackupError('Select a nonempty backup file.');
  if (buffer.length > limits.maxUploadBytes) throw new BackupError('Backup file exceeds the upload size limit.', 413);
  if (buffer.length < 3 || buffer[0] !== 0x1f || buffer[1] !== 0x8b || buffer[2] !== 0x08) {
    throw new BackupError('This is not a gzip account backup. Upload the original downloaded backup file.');
  }
  let expanded;
  try {
    // Node aborts expansion when this byte count is reached; compressed input
    // alone is not a useful bound against highly compressible malicious files.
    expanded = await gunzipAsync(buffer, { maxOutputLength: limits.maxExpandedBytes });
  } catch (error) {
    if (error.code === 'ERR_BUFFER_TOO_LARGE') throw new BackupError('Backup exceeds the expanded size limit.', 413);
    throw new BackupError('Backup file is damaged, incomplete, or cannot be decompressed.');
  }
  let envelope;
  try {
    // Fatal UTF-8 prevents silently replacing corrupted bytes with U+FFFD.
    const json = new TextDecoder('utf-8', { fatal: true }).decode(expanded);
    envelope = JSON.parse(json);
  } catch {
    throw new BackupError('Backup does not contain valid UTF-8 JSON data.');
  }
  if (!isObject(envelope) || envelope.format !== BACKUP_FORMAT) throw new BackupError('This file is not an RG Accounts backup.');
  if (envelope.version !== BACKUP_VERSION) throw new BackupError('This backup version is not supported. Use a compatible version of the account software.');
  if (typeof envelope.checksum !== 'string' || !/^[0-9a-f]{64}$/.test(envelope.checksum)) throw new BackupError('Backup integrity checksum is missing or invalid.');
  // Inspect envelope keys too, including unused metadata, before trusting it.
  for (const key of Object.keys(envelope)) {
    if (!['format', 'version', 'checksum', 'payload'].includes(key)) throw new BackupError('Backup envelope contains an unexpected field.');
  }
  validatePayload(envelope.payload);
  const checksum = sha256Payload(envelope.payload);
  if (!timingSafeEqual(Buffer.from(checksum, 'hex'), Buffer.from(envelope.checksum, 'hex'))) {
    throw new BackupError('Backup integrity check failed. The file has changed or is damaged.');
  }
  return { payload: envelope.payload, checksum };
}
