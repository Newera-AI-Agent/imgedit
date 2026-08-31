/**
 * Client-side file validation for image imports.
 */

export const SUPPORTED_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/bmp',
  'image/tiff',
] as const;

export const SUPPORTED_EXTENSIONS = [
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.bmp',
  '.tiff',
  '.tif',
] as const;

/** Maximum file size: 50 MB */
export const MAX_FILE_SIZE = 50 * 1024 * 1024;

export interface ValidationResult {
  valid: boolean;
  error?: string;
}

/**
 * Validate a File object for supported type and size.
 */
export function validateImageFile(file: File): ValidationResult {
  if (!file) {
    return { valid: false, error: 'No file selected.' };
  }

  if (file.size === 0) {
    return { valid: false, error: 'The selected file is empty.' };
  }

  if (file.size > MAX_FILE_SIZE) {
    const sizeMB = (file.size / (1024 * 1024)).toFixed(1);
    return {
      valid: false,
      error: `File is too large (${sizeMB} MB). Maximum allowed size is 50 MB.`,
    };
  }

  const mimeType = file.type.toLowerCase();
  const extension = '.' + (file.name.split('.').pop()?.toLowerCase() ?? '');

  const typeValid = (SUPPORTED_TYPES as readonly string[]).includes(mimeType);
  const extValid = (SUPPORTED_EXTENSIONS as readonly string[]).includes(extension);

  if (!typeValid && !extValid) {
    return {
      valid: false,
      error: `Unsupported file type. Please use PNG, JPEG, WebP, BMP, or TIFF files.`,
    };
  }

  return { valid: true };
}

/**
 * Get a safe export filename based on the original filename.
 */
export function getExportFilename(
  originalName: string | undefined,
  extension: 'png' | 'jpg'
): string {
  const base = originalName
    ? originalName.replace(/\.[^.]+$/, '') || 'edited'
    : 'edited';
  // Sanitize: remove path separators and limit length
  const sanitized = base.replace(/[/\\:*?"<>|]/g, '_').slice(0, 100);
  return `${sanitized}-edited.${extension}`;
}
