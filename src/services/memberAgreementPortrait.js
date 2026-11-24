import { createReadStream } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { memberDocumentStorage, readMemberDocumentObject } from '../utils/memberDocumentUrls.js';

const maxBytes = 10 * 1024 * 1024;

export function portraitStorage(value, env = process.env) {
  const s3 = memberDocumentStorage(value, env);
  if (s3) return { kind: 's3', storage: s3 };

  let url;
  try { url = new URL(value, 'http://localhost'); } catch { return null; }
  if (url.username || url.password) return null;
  if (url.protocol === 'https:' && url.host === 'res.cloudinary.com' && env.CLOUDINARY_CLOUD_NAME
    && url.pathname.startsWith('/' + env.CLOUDINARY_CLOUD_NAME + '/image/upload/')) {
    return { kind: 'cloudinary', url };
  }
  if (['localhost', '127.0.0.1'].includes(url.hostname) && ['http:', 'https:'].includes(url.protocol)) {
    const local = /^\/uploads\/kyc_documents\/([a-z\d_-][\w.-]*)$/i.exec(url.pathname);
    if (local) return { kind: 'local', filename: local[1] };
  }
  return null;
}

export async function portraitJpeg(bytes) {
  if (!bytes?.length || bytes.length > maxBytes) throw new Error('Portrait size is unsupported.');
  const options = { limitInputPixels: 40_000_000, failOn: 'warning' };
  const image = sharp(bytes, options);
  const metadata = await image.metadata();
  if (!['jpeg', 'png', 'webp', 'heif'].includes(metadata.format) || (metadata.pages || 1) !== 1) throw new Error('Portrait format is unsupported.');
  // Rotate from EXIF before stripping metadata and downsizing for print.
  return image.rotate().resize({ width: 640, height: 800, fit: 'inside', withoutEnlargement: true })
    .flatten({ background: '#ffffff' }).toColourspace('srgb').jpeg({ quality: 87 }).toBuffer();
}

export async function readAgreementPortrait(value, signal) {
  const source = portraitStorage(value);
  if (!source) throw new Error('Portrait storage is unavailable.');
  let stream;
  if (source.kind === 's3') {
    const object = await readMemberDocumentObject(source.storage, signal);
    stream = object.Body;
  } else if (source.kind === 'cloudinary') {
    // Only the stored image path in this installation's Cloudinary delivery
    // account is eligible. Never follow redirects or accept a client URL.
    const response = await fetch(source.url, { signal, redirect: 'error' });
    if (!response.ok) throw new Error('Portrait storage is unavailable.');
    stream = response.body;
  } else {
    stream = createReadStream(path.join(process.cwd(), 'uploads', 'kyc_documents', source.filename), { signal });
  }
  const chunks = [];
  let length = 0;
  for await (const chunk of stream) {
    length += chunk.length;
    if (length > maxBytes) throw new Error('Portrait size is unsupported.');
    chunks.push(chunk);
  }
  return portraitJpeg(Buffer.concat(chunks, length));
}
