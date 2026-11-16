import { createHash } from 'node:crypto';
import { Transform, Writable, PassThrough } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { S3Client, GetObjectCommand, DeleteObjectsCommand, ListObjectsV2Command, AbortMultipartUploadCommand } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

export function byteMeter({ maxBytes = Infinity, onBytes = () => {} } = {}) {
  const hash = createHash('sha256');
  let bytes = 0;
  const stream = new Transform({ transform(chunk, _encoding, done) {
    bytes += chunk.length;
    if (bytes > maxBytes) return done(new Error('Backup artifact exceeds the configured size limit.'));
    hash.update(chunk); onBytes(bytes); done(null, chunk);
  } });
  return { stream, result: () => ({ bytes, checksum: hash.digest('hex') }) };
}

export function createNativeBackupStorage(config, { client = new S3Client({ region: config.region, maxAttempts: 3,
  requestHandler: { connectionTimeout: 10000, requestTimeout: 60000 } }), UploadClass = Upload } = {}) {
  function validKey(key) {
    if (typeof key !== 'string' || !key.startsWith(`${config.prefix}/`) || /(^|\/)\.\.?($|\/)|[\x00-\x1f\\]/.test(key)) throw new Error('Invalid backup artifact key.');
  }
  const api = {
    async upload(key, input, { signal, onProgress = () => {}, contentType = 'application/octet-stream' } = {}) {
      validKey(key);
      if (signal?.aborted) throw signal.reason || new Error('Backup upload cancelled.');
      const transfer = new AbortController();
      let multipartId;
      // lib-storage 3.700 aborts its orchestration promise but does not pass an
      // AbortSignal to each send(). Explicitly abort network requests too.
      const uploadClient = { config: client.config, async send(command) {
        const cleanup = command instanceof AbortMultipartUploadCommand;
        try {
          const result = await client.send(command, { abortSignal: cleanup ? AbortSignal.timeout(15000) : transfer.signal });
          const name = command.constructor.name;
          if (name === 'CreateMultipartUploadCommand') {
            if (typeof result?.UploadId !== 'string' || !result.UploadId) throw new Error('S3 did not return a multipart upload identifier.');
            multipartId = result.UploadId;
          }
          if (['CompleteMultipartUploadCommand', 'PutObjectCommand'].includes(name) && !result?.ETag) throw new Error('S3 did not confirm a completed backup object.');
          return result;
        } catch (error) {
          // Abort siblings immediately; lib-storage otherwise waits for every
          // concurrent part before surfacing the first failed request.
          if (!cleanup) { transfer.abort(); output.destroy(error); }
          throw error;
        }
      } };
      const meter = byteMeter({ maxBytes: config.maxArchiveBytes });
      const output = new PassThrough({ highWaterMark: 64 * 1024 });
      const upload = new UploadClass({ client: uploadClient, params: {
        Bucket: config.bucket, Key: key, Body: output, ContentType: contentType,
        ServerSideEncryption: config.kmsKeyId ? 'aws:kms' : 'AES256',
        ...(config.kmsKeyId ? { SSEKMSKeyId: config.kmsKeyId } : {}),
      }, partSize: config.partSize, queueSize: config.uploadConcurrency, leavePartsOnError: false });
      upload.on('httpUploadProgress', event => onProgress(event.loaded || 0));
      const abort = () => { transfer.abort(); output.destroy(new Error('Backup upload cancelled.')); void upload.abort().catch(() => {}); };
      signal?.addEventListener('abort', abort, { once: true });
      try {
        // Attach both handlers immediately: either failure must tear down the other side.
        const transferring = upload.done().catch(error => { transfer.abort(); output.destroy(error); throw error; });
        const streaming = pipeline(input, meter.stream, output, { signal }).catch(async error => {
          transfer.abort(); await upload.abort().catch(() => {}); throw error;
        });
        const outcomes = await Promise.allSettled([transferring, streaming]);
        const failed = outcomes.find(result => result.status === 'rejected');
        if (failed) {
          if (multipartId) {
            try { await client.send(new AbortMultipartUploadCommand({ Bucket: config.bucket, Key: key, UploadId: multipartId }), { abortSignal: AbortSignal.timeout(15000) }); }
            catch { failed.reason.cleanupFailed = true; }
          }
          throw failed.reason;
        }
        return { ...meter.result(), versionId: outcomes[0].value.VersionId };
      } finally { signal?.removeEventListener('abort', abort); }
    },
    async read(key, { signal } = {}) {
      validKey(key);
      const object = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: key }), { abortSignal: signal });
      if (!object.Body?.pipe) throw new Error('Backup storage did not return a readable object.');
      return object.Body;
    },
    async verify(key, expected, { signal, consumer } = {}) {
      const input = await api.read(key, { signal });
      const meter = byteMeter({ maxBytes: config.maxArchiveBytes });
      await pipeline(input, meter.stream, consumer || new Writable({ write(_chunk, _enc, done) { done(); } }), { signal });
      const result = meter.result();
      if (result.bytes !== Number(expected.bytes) || result.checksum !== expected.checksum) throw new Error('Stored backup checksum verification failed.');
      return result;
    },
    async removePrefix(prefix, { signal } = {}) {
      validKey(prefix);
      // Require an attempt-scoped prefix, never a bucket or all-backups deletion.
      if (!/\/attempt-\d+-[0-9a-f-]+\/$/.test(prefix)) throw new Error('Invalid cleanup prefix.');
      let continuation;
      do {
        const page = await client.send(new ListObjectsV2Command({ Bucket: config.bucket, Prefix: prefix, ContinuationToken: continuation, MaxKeys: 500 }), { abortSignal: signal || AbortSignal.timeout(60000) });
        if (page.Contents?.length) {
          const result = await client.send(new DeleteObjectsCommand({ Bucket: config.bucket, Delete: { Objects: page.Contents.map(({ Key }) => ({ Key })), Quiet: true } }), { abortSignal: signal || AbortSignal.timeout(60000) });
          if (result.Errors?.length) throw new Error('Backup artifact cleanup failed.');
        }
        continuation = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (continuation);
    },
    async presign(job) {
      validKey(job.artifactKey);
      const suffix = job.artifactKey.endsWith('/manifest.json') ? '-manifest.json'
        : job.artifactKey.endsWith('/files.ndjson') ? '-files.ndjson'
        : job.artifactKey.includes('/files/') ? `-file-${job.artifactKey.split('/').at(-1)}` : '.dump';
      const filename = `accounts-${job.id}${suffix}`;
      const url = await getSignedUrl(client, new GetObjectCommand({ Bucket: config.bucket, Key: job.artifactKey,
        ResponseContentType: 'application/octet-stream', ResponseContentDisposition: `attachment; filename="${filename}"` }), { expiresIn: 60 });
      return { url, filename, expiresAt: new Date(Date.now() + 60000).toISOString() };
    },
  };
  return api;
}
