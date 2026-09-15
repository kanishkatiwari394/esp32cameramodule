import cloudinaryPackage from 'cloudinary';
import { randomUUID } from 'node:crypto';
import { HttpError } from './http.js';

// Server-side only. CLOUDINARY_API_SECRET is never sent to the browser or the ESP32.
export const cloudinary = cloudinaryPackage.v2;

let configured = false;

export function isCloudinaryConfigured() {
  const { CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET } = process.env;
  return Boolean(CLOUDINARY_CLOUD_NAME && CLOUDINARY_API_KEY && CLOUDINARY_API_SECRET);
}

function configure() {
  if (!isCloudinaryConfigured()) {
    throw new HttpError(500, 'Server is not configured: Cloudinary credentials are missing');
  }
  if (!configured) {
    cloudinary.config({
      cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
      api_key: process.env.CLOUDINARY_API_KEY,
      api_secret: process.env.CLOUDINARY_API_SECRET,
      secure: true,
    });
    configured = true;
  }
}

/** Uploads an already-validated image buffer and returns its permanent HTTPS URL. */
export async function uploadDetectionImage(buffer, { deviceId, readerId, rfidUid }) {
  configure();
  const folder = process.env.CLOUDINARY_FOLDER || 'raksha-rail/detections';
  const publicId = `${new Date().toISOString().replace(/[:.]/g, '-')}_${randomUUID().slice(0, 8)}`;

  let result;
  try {
    result = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        {
          folder,
          public_id: publicId,
          resource_type: 'image',
          overwrite: false,
          tags: ['raksha-rail', deviceId, readerId],
          context: { deviceId, readerId, rfidUid },
          timeout: 20000,
        },
        (error, uploaded) => (error ? reject(error) : resolve(uploaded)),
      );
      stream.end(buffer);
    });
  } catch (err) {
    console.error('[cloudinary] upload failed:', err?.http_code, err?.message);
    if (err?.http_code === 400) {
      throw new HttpError(422, `Image rejected by Cloudinary: ${err.message}`);
    }
    throw new HttpError(502, 'Image upload to Cloudinary failed');
  }

  return {
    url: result.secure_url,
    publicId: result.public_id,
    width: result.width ?? null,
    height: result.height ?? null,
    bytes: result.bytes ?? buffer.length,
    format: result.format ?? null,
  };
}

/** Used to roll back an upload when the database insert fails. */
export async function deleteImage(publicId) {
  configure();
  await cloudinary.uploader.destroy(publicId, { resource_type: 'image' });
}
