/** Client-side validation and filename helpers for image imports. */

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

export const MAX_FILE_SIZE = 50 * 1024 * 1024;

export interface ValidationResult {
  valid: boolean;
  error?: string;
}

export function validateImageFile(file: File): ValidationResult {
  if (!file) return { valid: false, error: 'No file selected.' };
  if (file.size === 0) return { valid: false, error: 'The selected file is empty.' };
  if (file.size > MAX_FILE_SIZE) {
    const sizeMB = (file.size / (1024 * 1024)).toFixed(1);
    return {
      valid: false,
      error: `File is too large (${sizeMB} MB). Maximum allowed size is 50 MB.`,
    };
  }

  const mimeType = file.type.toLowerCase();
  const extension = `.${file.name.split('.').pop()?.toLowerCase() ?? ''}`;
  const typeValid = (SUPPORTED_TYPES as readonly string[]).includes(mimeType);
  const extensionValid = (SUPPORTED_EXTENSIONS as readonly string[]).includes(extension);
  if (!typeValid && !extensionValid) {
    return { valid: false, error: 'Unsupported file type. Please use PNG, JPEG, WebP, BMP, or TIFF files.' };
  }

  return { valid: true };
}


export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`;
}
