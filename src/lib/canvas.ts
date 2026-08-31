/**
 * Canvas rendering utilities for Imgedit.
 * Pure functions for applying image transformations and exporting.
 */

export interface EditorAdjustments {
  brightness: number;
  contrast: number;
  saturation: number;
  blur: number;
}

export interface EditorTransform {
  rotation: number;
  flipH: boolean;
  flipV: boolean;
  zoom: number;
}

export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ExportOptions {
  format: 'image/png' | 'image/jpeg';
  quality?: number;
}

export const DEFAULT_ADJUSTMENTS: EditorAdjustments = {
  brightness: 0,
  contrast: 0,
  saturation: 0,
  blur: 0,
};

export const DEFAULT_TRANSFORM: EditorTransform = {
  rotation: 0,
  flipH: false,
  flipV: false,
  zoom: 1,
};

export const ASPECT_RATIOS = [
  { label: 'Freeform', value: 0 },
  { label: '1:1 (Square)', value: 1 },
  { label: '4:3', value: 4 / 3 },
  { label: '3:2', value: 3 / 2 },
  { label: '16:9', value: 16 / 9 },
  { label: '3:4', value: 3 / 4 },
  { label: '2:3', value: 2 / 3 },
  { label: '9:16', value: 9 / 16 },
] as const;

/**
 * Render the source image onto a canvas with adjustments and transforms applied.
 */
export function renderImage(
  canvas: HTMLCanvasElement,
  image: HTMLImageElement,
  adjustments: EditorAdjustments,
  transform: EditorTransform,
  crop?: CropRect
): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const srcW = crop ? crop.width : image.naturalWidth;
  const srcH = crop ? crop.height : image.naturalHeight;
  const srcX = crop ? crop.x : 0;
  const srcY = crop ? crop.y : 0;

  canvas.width = srcW * transform.zoom;
  canvas.height = srcH * transform.zoom;

  ctx.save();

  // Apply flip transforms
  if (transform.flipH || transform.flipV) {
    ctx.translate(
      transform.flipH ? canvas.width : 0,
      transform.flipV ? canvas.height : 0
    );
    ctx.scale(transform.flipH ? -1 : 1, transform.flipV ? -1 : 1);
  }

  // Apply rotation around center
  if (transform.rotation !== 0) {
    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.rotate((transform.rotation * Math.PI) / 180);
    ctx.translate(-canvas.width / 2, -canvas.height / 2);
  }

  // Build CSS filter string from adjustments
  const filters: string[] = [];
  if (adjustments.brightness !== 0) {
    filters.push(`brightness(${100 + adjustments.brightness}%)`);
  }
  if (adjustments.contrast !== 0) {
    filters.push(`contrast(${100 + adjustments.contrast}%)`);
  }
  if (adjustments.saturation !== 0) {
    filters.push(`saturate(${100 + adjustments.saturation}%)`);
  }
  if (adjustments.blur > 0) {
    filters.push(`blur(${adjustments.blur}px)`);
  }
  ctx.filter = filters.join(' ');

  ctx.drawImage(
    image,
    srcX, srcY, srcW, srcH,
    0, 0, canvas.width, canvas.height
  );

  ctx.restore();
}

/**
 * Compute a centered crop rectangle based on aspect ratio.
 */
export function computeCenteredCrop(
  imageWidth: number,
  imageHeight: number,
  aspectRatio: number
): CropRect {
  if (aspectRatio <= 0) {
    return { x: 0, y: 0, width: imageWidth, height: imageHeight };
  }

  let cropW = imageWidth;
  let cropH = imageHeight;
  const currentRatio = imageWidth / imageHeight;

  if (currentRatio > aspectRatio) {
    cropW = imageHeight * aspectRatio;
  } else {
    cropH = imageWidth / aspectRatio;
  }

  return {
    x: Math.round((imageWidth - cropW) / 2),
    y: Math.round((imageHeight - cropH) / 2),
    width: Math.round(cropW),
    height: Math.round(cropH),
  };
}

/**
 * Export the current canvas state to a Blob.
 */
export function exportCanvasToBlob(
  canvas: HTMLCanvasElement,
  options: ExportOptions
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) {
          resolve(blob);
        } else {
          reject(new Error('Failed to export canvas'));
        }
      },
      options.format,
      options.quality ?? (options.format === 'image/jpeg' ? 0.92 : undefined)
    );
  });
}

/**
 * Generate a download filename based on the source filename and target format.
 */
export function generateExportFilename(
  sourceName: string,
  format: 'image/png' | 'image/jpeg'
): string {
  const base = sourceName.replace(/\.[^.]+$/, '') || 'imgedit-export';
  const ext = format === 'image/jpeg' ? 'jpg' : 'png';
  return `${base}-edited.${ext}`;
}
