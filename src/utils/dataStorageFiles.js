import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { unlink } from 'node:fs/promises';
import path from 'node:path';
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';

// New uploads always go to S3. Legacy local keys remain readable so enabling
// AWS does not strand any existing development files. There is no static mount.
const localDirectory = path.join(process.cwd(), 'uploads', 'data_storage');
const bucket = process.env.AWS_S3_BUCKET_NAME || process.env.AWS_S3_BUCKET;
const s3 = bucket ? new S3Client({
  region: process.env.AWS_REGION || 'ap-south-1',
  ...(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY ? {
    credentials: { accessKeyId: process.env.AWS_ACCESS_KEY_ID, secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY },
  } : {}),
}) : null;

const localPath = (key) => {
  const name = key.slice('local::'.length);
  if (!/^[0-9a-f-]{36}$/.test(name)) throw new Error('Invalid storage key');
  return path.join(localDirectory, name);
};

export function createDataStorageFiles({ s3Client = s3, bucketName = bucket } = {}) {
  const requireS3 = () => {
    if (!s3Client || !bucketName) throw Object.assign(new Error('AWS file storage is not configured.'), { statusCode: 503 });
  };
  return {
  async upload(buffer, siteId) {
    requireS3();
    const key = `data_storage/${siteId}/${randomUUID()}`;
    await s3Client.send(new PutObjectCommand({ Bucket: bucketName, Key: key, Body: buffer, ContentType: 'application/octet-stream' }));
    return key;
  },
  async open(key) {
    if (key.startsWith('local::')) return createReadStream(localPath(key));
    requireS3();
    const response = await s3Client.send(new GetObjectCommand({ Bucket: bucketName, Key: key }));
    return response.Body;
  },
  async remove(key) {
    if (key.startsWith('local::')) {
      try { await unlink(localPath(key)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      return;
    }
    requireS3();
    await s3Client.send(new DeleteObjectCommand({ Bucket: bucketName, Key: key }));
  },
  };
}

export const dataStorageFiles = createDataStorageFiles();
