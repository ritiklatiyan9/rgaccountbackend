import sharp from 'sharp';
import pool from '../config/db.js';
import applicationSettingModel from '../models/ApplicationSetting.model.js';

export const RECEIPT_SIGNATURE_KEY = 'receipt_signature_v1';
export const MAX_SIGNATURE_BYTES = 5 * 1024 * 1024;
export const MIN_SIGNATURE_SIZE_PERCENT = 50;
export const MAX_SIGNATURE_SIZE_PERCENT = 200;
export const receiptSignatureSizePercent = value => typeof value === 'number' && Number.isFinite(value)
  ? Math.max(MIN_SIGNATURE_SIZE_PERCENT, Math.min(MAX_SIGNATURE_SIZE_PERCENT, Math.round(value))) : 100;
export const emptyReceiptSignature = () => ({ enabled: false, image_data_url: '', file_name: '', size_percent: 100 });

export function normalizeReceiptSignature(value) {
  const image = typeof value?.image_data_url === 'string'
    && /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(value.image_data_url)
    ? value.image_data_url : '';
  return {
    enabled: value?.enabled === true && Boolean(image),
    image_data_url: image,
    file_name: image && typeof value?.file_name === 'string' ? value.file_name.slice(0, 160) : '',
    size_percent: receiptSignatureSizePercent(value?.size_percent),
  };
}

export async function getReceiptSignature(siteId, db = pool) {
  if (!siteId) return emptyReceiptSignature();
  const stored = db === pool ? await applicationSettingModel.getJson(siteId, RECEIPT_SIGNATURE_KEY, null)
    : (await db.query('SELECT setting_value FROM application_settings WHERE site_id = $1 AND setting_key = $2 LIMIT 1',
      [siteId, RECEIPT_SIGNATURE_KEY])).rows[0]?.setting_value;
  return normalizeReceiptSignature(stored);
}

export async function prepareReceiptSignature(file) {
  if (!file?.buffer?.length) throw Object.assign(new Error('Choose a signature image to upload.'), { statusCode: 400 });
  if (file.buffer.length > MAX_SIGNATURE_BYTES) throw Object.assign(new Error('Signature images must be 5 MB or smaller.'), { statusCode: 413 });
  if (!/\.(png|jpe?g)$/i.test(file.originalname || '') || !['image/png', 'image/jpeg'].includes(file.mimetype)) {
    throw Object.assign(new Error('Upload a PNG, JPG or JPEG image.'), { statusCode: 400 });
  }
  try {
    const options = { limitInputPixels: 20_000_000, failOn: 'warning' };
    const metadata = await sharp(file.buffer, options).metadata();
    if (!['png', 'jpeg'].includes(metadata.format) || (metadata.pages || 1) > 1) throw new Error('Unsupported image');
    // Trim paper/transparent margins before fitting, so a photographed signature
    // stays legible inside the same physical field as a transparent PNG.
    const image = await sharp(file.buffer, options).rotate().toColourspace('srgb').ensureAlpha()
      .trim({ threshold: 20 })
      .resize({ width: 1200, height: 360, fit: 'inside', withoutEnlargement: true })
      .png({ compressionLevel: 9 }).toBuffer();
    return {
      image_data_url: `data:image/png;base64,${image.toString('base64')}`,
      file_name: file.originalname.split(/[\\/]/).pop().replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 160),
    };
  } catch {
    throw Object.assign(new Error('This image could not be read. Choose a valid PNG, JPG or JPEG image up to 20 megapixels.'), { statusCode: 400 });
  }
}

// The bounded PNG is kept with this site's settings. Receipts can embed it
// without expiring URLs, public storage permissions, or a second image fetch.
export const saveReceiptSignature = (siteId, value, updatedBy) =>
  applicationSettingModel.setJson(siteId, RECEIPT_SIGNATURE_KEY, normalizeReceiptSignature(value), updatedBy);
