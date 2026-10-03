import { createHash } from 'node:crypto';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import pool from '../config/db.js';
import { encrypt, decrypt } from '../utils/tokenCrypto.js';
import { memberDocumentStorage } from '../utils/memberDocumentUrls.js';

export const DRIVE_DOCUMENT_LINK_PATH = '/public/drive-documents';
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const failure = (message, statusCode = 403, code = 'DRIVE_DOCUMENT_LINK_REVOKED') => Object.assign(new Error(message), { statusCode, code });
const positiveId = (value) => Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : null;
const clients = new Map();

/** Resolve only configured S3 buckets. No network access or arbitrary URL fetch. */
export const driveDocumentStorage = (value, env = process.env) => {
  const raw = String(value || '').trim();
  if (!raw || raw.startsWith('local::') || raw.length > 8192 || /(?:^|\/)(?:\.|%2e){1,2}(?:\/|%2f|[?#]|$)/i.test(raw)) return null;
  let storage;
  if (/^https:\/\//i.test(raw)) storage = memberDocumentStorage(raw, env);
  else {
    if (raw.includes('://') || raw.includes(':') || raw.startsWith('/') || raw.includes('?') || raw.includes('#')) return null;
    const Bucket = env.AWS_S3_BUCKET_NAME || env.AWS_S3_BUCKET;
    if (!Bucket) return null;
    storage = { Bucket, Key: raw, region: env.AWS_REGION || 'ap-south-1', profile: 'current',
      ...(env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY ? { credentials: { accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY } } : {}) };
  }
  if (!storage || !storage.Key || Buffer.byteLength(storage.Key) > 1024 || /[\\\x00-\x1f]/.test(storage.Key)
    || storage.Key.split('/').some((part) => part === '..' || part === '.')) return null;
  return storage;
};

const publicBaseUrl = (explicit, env) => {
  const configured = explicit || env.PUBLIC_API_URL || env.BACKEND_URL || env.API_BASE_URL;
  let raw = configured;
  if (!raw && env.GOOGLE_REDIRECT_URI) raw = new URL(env.GOOGLE_REDIRECT_URI).origin;
  if (!raw && env.NODE_ENV !== 'production') raw = `http://localhost:${env.PORT || 3000}`;
  if (!raw) throw failure('Public document links are not configured', 503, 'DRIVE_DOCUMENT_LINKS_NOT_CONFIGURED');
  const url = new URL(raw);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
    || url.username || url.password || url.search || url.hash) throw failure('Public document link address is invalid', 503, 'DRIVE_DOCUMENT_LINKS_NOT_CONFIGURED');
  return `${url.origin}${url.pathname.replace(/\/$/, '')}`;
};

/** Current access, checked both when issuing a link and on every open. Changing
 * the recipient set/role or recreating its permissions revokes existing links.
 * Re-sharing then writes new links for the remaining recipients. */
const accessVersion = async (orgId, siteId, db) => {
  const [connectionResult, grantsResult] = await Promise.all([
    db.query(`SELECT c.id, c.google_account_email, c.root_folder_id
      FROM google_drive_connections c
      WHERE c.organization_id=$1 AND c.status='active'
        AND ($2::int IS NULL OR EXISTS (SELECT 1 FROM sites s WHERE s.id=$2 AND s.organization_id=$1))`, [orgId, siteId]),
    db.query(`SELECT id, site_id, role, drive_permission_id, created_at
      FROM google_drive_access_emails
      WHERE organization_id=$1 AND (site_id=$2 OR site_id IS NULL)
      ORDER BY id`, [orgId, siteId]),
  ]);
  const connection = connectionResult.rows[0];
  if (!connection) throw failure('This document link is unavailable because Drive access was disconnected or its site changed.');
  const grants = grantsResult.rows.filter((row) => row.drive_permission_id);
  return { version: hash({ orgId, siteId, connection, grants }), canOpen: grants.length > 0 };
};

const sourceValue = (document) => document.storage_key || document.file_path || document.url;

/** Only call with documents from an already-authorized module/site bundle.
 * This is not exposed as a URL-signing endpoint. Tokens contain one encrypted
 * object capability; caller-provided URLs never reach the public resolver. */
export const prepareDriveDocumentLinks = async ({ orgId, siteId, documents = [], baseUrl }, { db = pool, env = process.env } = {}) => {
  if (!documents.length) return [];
  orgId = positiveId(orgId);
  const requestedSiteId = siteId;
  siteId = siteId == null ? null : positiveId(siteId);
  if (!orgId || (requestedSiteId != null && !siteId)) throw failure('Invalid document access scope', 400);
  let access;
  try { access = await accessVersion(orgId, siteId, db); } catch (err) {
    if (err.code !== 'DRIVE_DOCUMENT_LINK_REVOKED') throw err;
    access = { version: hash({ orgId, siteId, disconnected: true }), canOpen: false, unavailable: 'Connect Google Drive and add CA access, then share again' };
  }
  const base = access.canOpen ? publicBaseUrl(baseUrl, env) : '';
  return documents.map((document) => {
    const storage = driveDocumentStorage(sourceValue(document), env);
    const result = {
      id: document.id, name: String(document.name || document.title || document.original_name || 'Document'),
      sourceModule: document.sourceModule || null, sourceId: document.sourceId ?? null,
      sourceFingerprint: hash(storage ? { Bucket: storage.Bucket, Key: storage.Key, region: storage.region } : { unavailable: String(sourceValue(document) || '').split('?')[0] }),
      // Moving the public API address must refresh already-shared hyperlinks.
      linkVersion: hash({ access: access.version, base }),
    };
    if (!storage) return { ...result, url: null, unavailable: 'Stored outside configured cloud storage' };
    if (!access.canOpen) return { ...result, url: null, unavailable: access.unavailable || 'Add CA access in Google Drive settings, then share again' };
    const packed = encrypt(JSON.stringify({ purpose: 'drive-document', v: 1, orgId, siteId, access: access.version,
      object: { Bucket: storage.Bucket, Key: storage.Key, region: storage.region }, sourceModule: result.sourceModule, sourceId: result.sourceId }));
    const token = Buffer.from(packed, 'base64').toString('base64url');
    return { ...result, url: `${base}${DRIVE_DOCUMENT_LINK_PATH}/${token}` };
  });
};

const signObject = async (storage) => {
  const { Bucket, Key, region, profile, credentials } = storage;
  const key = `${profile}:${Bucket}:${region}`;
  if (!clients.has(key)) clients.set(key, new S3Client({ region, ...(credentials ? { credentials } : {}) }));
  return getSignedUrl(clients.get(key), new GetObjectCommand({ Bucket, Key }), { expiresIn: 300 });
};

/** Authenticate/decrypt first, revalidate current access, then issue a fresh
 * five-minute S3 URL. Revocation blocks subsequent opens of the durable link;
 * a previously issued S3 URL remains valid only for its short expiry window. */
export const resolveDriveDocumentLink = async (token, { db = pool, env = process.env, sign = signObject } = {}) => {
  let payload;
  try {
    if (typeof token !== 'string' || token.length > 8192 || !/^[A-Za-z0-9_-]+$/.test(token)) throw new Error('invalid token');
    payload = JSON.parse(decrypt(Buffer.from(token, 'base64url').toString('base64')));
    if (payload.purpose !== 'drive-document' || payload.v !== 1 || !positiveId(payload.orgId)
      || (payload.siteId !== null && !positiveId(payload.siteId)) || !/^[a-f\d]{64}$/.test(payload.access)) throw new Error('invalid scope');
  } catch { throw failure('This document link is invalid or no longer available.', 404, 'DRIVE_DOCUMENT_LINK_INVALID'); }
  const object = payload.object || {};
  const encodedKey = String(object.Key || '').split('/').map(encodeURIComponent).join('/');
  const storage = driveDocumentStorage(`https://${object.Bucket}.s3.${object.region}.amazonaws.com/${encodedKey}`, env);
  if (!storage) throw failure('This document storage location is no longer available.');
  const access = await accessVersion(Number(payload.orgId), payload.siteId == null ? null : Number(payload.siteId), db);
  if (!access.canOpen || access.version !== payload.access) throw failure('CA access changed. Ask the account owner to share the workbook again.');
  return sign(storage);
};
