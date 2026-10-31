import sharp from 'sharp';

/** JPEG files start with the SOI marker followed by another marker (FF D8 FF). */
export function isJpeg(bytes: Uint8Array): boolean {
  return bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

export class InvalidImageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidImageError';
  }
}

/** Refuse absurd dimensions before decoding (decompression bombs). */
const MAX_INPUT_PIXELS = 4096 * 4096;

/**
 * Re-encodes report evidence: decodes the image (it must really be a JPEG), applies the EXIF
 * orientation, caps the size and writes a fresh JPEG — without any metadata (EXIF, GPS, ...).
 */
export async function sanitizeJpeg(bytes: Uint8Array): Promise<Buffer> {
  if (!isJpeg(bytes)) throw new InvalidImageError('Not a JPEG image');
  try {
    return await sharp(bytes, { limitInputPixels: MAX_INPUT_PIXELS, failOn: 'error' })
      .rotate()
      .resize({ width: 1280, height: 1280, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 85, mozjpeg: true })
      .toBuffer();
  } catch {
    throw new InvalidImageError('Unreadable image');
  }
}

/** Dimensions of a JPEG without re-encoding it (moderation frames are deleted after use). */
export async function jpegSize(bytes: Uint8Array): Promise<{ width: number; height: number }> {
  if (!isJpeg(bytes)) throw new InvalidImageError('Not a JPEG image');
  try {
    const { width, height, format } = await sharp(bytes, {
      limitInputPixels: MAX_INPUT_PIXELS,
    }).metadata();
    if (format !== 'jpeg') throw new InvalidImageError('Not a JPEG image');
    return { width, height };
  } catch (error) {
    if (error instanceof InvalidImageError) throw error;
    throw new InvalidImageError('Unreadable image');
  }
}
