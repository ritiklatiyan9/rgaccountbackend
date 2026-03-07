import { v2 as cloudinary } from 'cloudinary';

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

export const uploadToCloudinary = async (filePath, folder = 'uploads') => {
  const result = await cloudinary.uploader.upload(filePath, {
    folder,
    // Compress & resize images to reduce size
    transformation: [
      { width: 1200, crop: 'limit' },     // max width 1200px
      { quality: 'auto:good' },            // auto quality optimization
      { fetch_format: 'auto' },            // auto format (webp/avif where supported)
    ],
    resource_type: 'auto',
  });
  return result.secure_url;
};