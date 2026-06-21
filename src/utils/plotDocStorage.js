import { S3Client, DeleteObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Upload } from '@aws-sdk/lib-storage';
import fs from 'fs';
import path from 'path';

/**
 * Plot-document storage — deliberately mirrors booking-api/src/utils/s3.js so files written
 * here are byte-identical and cross-readable by the booking module. Documents live under the
 * shared `kyc_documents/` prefix in the SAME S3 bucket both apps use (env AWS_S3_BUCKET_NAME),
 * so a doc uploaded from the Account app is viewable from the Booking app and vice versa.
 *
 * In local dev without S3 we fall back to disk (`local::<name>`), served by the static route in
 * app.js. NOTE: the local fallback is per-process, so true cross-app sharing requires S3 (which
 * is configured in this project's .env files).
 */

let s3Client = null;
if (process.env.AWS_ACCESS_KEY_ID) {
  s3Client = new S3Client({
    region: process.env.AWS_REGION || 'ap-south-1',
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    },
  });
}

const BUCKET = process.env.AWS_S3_BUCKET_NAME || process.env.AWS_S3_BUCKET || '';
// Co-locate with the booking module's local fallback dir name so dev files are predictable.
const LOCAL_DIR = path.join(process.cwd(), 'uploads', 'kyc_documents');
if (!fs.existsSync(LOCAL_DIR)) fs.mkdirSync(LOCAL_DIR, { recursive: true });

const usingS3 = () => Boolean(s3Client && process.env.AWS_ACCESS_KEY_ID && BUCKET);

/** Upload a plot document buffer. Returns a storage key: an S3 key, or `local::<name>`. */
export const uploadPlotDoc = async (fileBuffer, originalName, mimetype) => {
  const safeName = `${Date.now()}-${Math.round(Math.random() * 1e9)}-${String(originalName || 'file').replace(/[^\w.\-]/g, '_')}`;
  const key = `kyc_documents/${safeName}`;

  if (usingS3()) {
    const upload = new Upload({
      client: s3Client,
      params: { Bucket: BUCKET, Key: key, Body: fileBuffer, ContentType: mimetype },
      queueSize: 4,
      partSize: 5 * 1024 * 1024,
    });
    await upload.done();
    return key;
  }
  fs.writeFileSync(path.join(LOCAL_DIR, safeName), fileBuffer);
  return `local::${safeName}`;
};

/** A browser-usable URL for a stored doc (signed for S3, static path for local). */
export const getPlotDocUrl = async (storageKey) => {
  if (!storageKey) return null;
  if (storageKey.startsWith('local::')) {
    const name = storageKey.replace('local::', '');
    return `http://localhost:${process.env.PORT || 8000}/uploads/kyc_documents/${name}`;
  }
  if (usingS3()) {
    const cmd = new GetObjectCommand({ Bucket: BUCKET, Key: storageKey });
    return await getSignedUrl(s3Client, cmd, { expiresIn: 3600 });
  }
  return null;
};

/** Delete a stored doc from S3 or local disk (best-effort). */
export const deletePlotDoc = async (storageKey) => {
  if (!storageKey) return;
  if (storageKey.startsWith('local::')) {
    const p = path.join(LOCAL_DIR, storageKey.replace('local::', ''));
    if (fs.existsSync(p)) fs.unlinkSync(p);
  } else if (usingS3()) {
    await s3Client.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: storageKey }));
  }
};

export const isS3Enabled = usingS3;
