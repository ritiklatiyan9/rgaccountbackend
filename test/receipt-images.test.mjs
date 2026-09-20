import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { loadReceiptImage, parseS3ImageUrl } from '../src/utils/receiptImages.js';

test('uses the region of each stored image, including before the bucket migration', () => {
  assert.deepEqual(parseS3ImageUrl('https://mountreality.s3.us-east-1.amazonaws.com/vouchers/a%20b.png'),{Bucket:'mountreality',region:'us-east-1',Key:'vouchers/a b.png'});
  assert.equal(parseS3ImageUrl('https://old.s3.ap-south-1.amazonaws.com/a.png').region,'ap-south-1');
  assert.equal(parseS3ImageUrl('https://bucket.s3.us-east-1.amazonaws.com.evil.test/a.png'),null);
  assert.equal(parseS3ImageUrl('http://127.0.0.1/image'),null);
});

test('embeds actual stored image bytes without relying on public access or S3 browser CORS', async () => {
  const bytes=Buffer.from([137,80,78,71,13,10,26,10,1,2]);
  const result=await loadReceiptImage('https://mountreality.s3.us-east-1.amazonaws.com/signature.png',async command=>{
    assert.equal(command.region,'us-east-1');assert.equal(command.Key,'signature.png');
    return {ContentLength:bytes.length,Body:Readable.from([bytes])};
  });
  assert.equal(result,`data:image/png;base64,${bytes.toString('base64')}`);
});

test('rejects non-image and oversized objects and propagates storage access errors', async () => {
  const url='https://mountreality.s3.us-east-1.amazonaws.com/signature.png';
  await assert.rejects(loadReceiptImage(url,async()=>({Body:Readable.from([Buffer.from('<html>error</html>')])})),/not a supported image/);
  await assert.rejects(loadReceiptImage(url,async()=>({ContentLength:6*1024*1024})),/size limit/);
  await assert.rejects(loadReceiptImage(url,async()=>{throw new Error('AccessDenied');}),/AccessDenied/);
});
