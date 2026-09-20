import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';

const clients = new Map();
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

const completeCredentials = (accessKeyId, secretAccessKey) => (
  accessKeyId && secretAccessKey ? { accessKeyId, secretAccessKey } : undefined
);

// Receipt URLs can outlive a bucket migration. The normal AWS_* credentials
// belong to the current upload bucket; optional LEGACY_AWS_* credentials keep
// older receipts printable without making either bucket public.
export function receiptImageStorageProfile(source, env = process.env) {
  const legacyBucket = env.LEGACY_AWS_S3_BUCKET_NAME || env.LEGACY_AWS_S3_BUCKET;
  if (legacyBucket && source.Bucket === legacyBucket) {
    return {
      name: 'legacy',
      credentials: completeCredentials(env.LEGACY_AWS_ACCESS_KEY_ID, env.LEGACY_AWS_SECRET_ACCESS_KEY),
    };
  }
  return {
    name: 'current',
    credentials: completeCredentials(env.AWS_ACCESS_KEY_ID, env.AWS_SECRET_ACCESS_KEY),
  };
}

export function parseS3ImageUrl(value) {
  let url;
  try { url = new URL(value); } catch { return null; }
  const match = url.hostname.match(/^(.+)\.s3[.-]([a-z]{2}-[a-z]+-\d)\.amazonaws\.com$/);
  if (url.protocol !== 'https:' || !match || url.username || url.password || url.port) return null;
  return { Bucket: match[1], Key: decodeURIComponent(url.pathname.slice(1)), region: match[2] };
}

// Call only with URLs read from a record whose module and site access have
// already been checked. Never expose a general-purpose URL/bucket reader.
export async function loadReceiptImage(value, readObject = async ({ region, ...input }) => {
  const profile = receiptImageStorageProfile({ region, ...input });
  const clientKey = `${profile.name}:${region}:${input.Bucket}`;
  if (!clients.has(clientKey)) {
    clients.set(clientKey, new S3Client({ region, ...(profile.credentials ? { credentials: profile.credentials } : {}) }));
  }
  return clients.get(clientKey).send(new GetObjectCommand(input), { abortSignal: AbortSignal.timeout(15000) });
}) {
  const source = parseS3ImageUrl(value);
  if (!source) return value;
  const object = await readObject(source);
  if (object.ContentLength > MAX_IMAGE_BYTES) {
    object.Body?.destroy?.();
    throw new Error('Signature image exceeds the size limit');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of object.Body) {
    size += chunk.length;
    if (size > MAX_IMAGE_BYTES) {
      object.Body?.destroy?.();
      throw new Error('Signature image exceeds the size limit');
    }
    chunks.push(Buffer.from(chunk));
  }
  const bytes = Buffer.concat(chunks);
  let type;
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) type = 'image/png';
  else if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) type = 'image/jpeg';
  else if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') type = 'image/webp';
  else throw new Error('Stored signature is not a supported image');
  return `data:${type};base64,${bytes.toString('base64')}`;
}
