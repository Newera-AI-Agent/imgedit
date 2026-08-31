# CONTRACTS

AUTO-GENERATED after every successful file write. Do not edit by hand - your edits will be overwritten.

This is the authoritative list of what exists in this project. If a symbol is not listed here and not in a file you have read during this run, IT DOES NOT EXIST. Do not reference it. Read the file or write the symbol first.

## Dependencies (package.json)

- `@tailwindcss/postcss` `^4`
- `@types/node` `^20`
- `@types/react` `^19`
- `@types/react-dom` `^19`
- `eslint` `^9`
- `eslint-config-next` `16.3.3`
- `next` `16.3.3`
- `react` `19.2.8`
- `react-dom` `19.2.8`
- `tailwindcss` `^4`
- `typescript` `^5`

Scripts: `dev`, `build`, `start`, `lint`

## Files and public API

### `eslint.config.mjs` - 19 lines
- exports: (nothing public)

### `next-env.d.ts` - 8 lines
- imports: `.next/types/routes.d.ts`, `.next/types/root-params.d.ts`
- exports: (nothing public)

### `next.config.ts` - 8 lines
- exports: (nothing public)

### `postcss.config.mjs` - 8 lines
- exports: (nothing public)

### `src/app/globals.css` - 27 lines
- exports: (nothing public)

### `src/app/layout.tsx` - 30 lines
- imports: `src/app/globals.css`
- `RootLayout` (function)
- `metadata` (const): description, title
- default export: `RootLayout`

### `src/app/page.tsx` - 70 lines
- `Home` (function)
- default export: `Home`

### `src/components/EmptyState.tsx` - 115 lines
- `EmptyState` (function)
- default export: `EmptyState`

### `src/hooks/useImageEditor.ts` - 450 lines
- imports: `src/lib/canvas.ts`, `src/lib/validation.ts`
- `EditorImage` (interface): element, file, height, name, objectUrl, width
- `EditorState` (interface): adjustments, crop, cropAspectRatio, cropMode, error, exportMessage, image, redoStack, status, transform, undoStack
- `useImageEditor` (function)
- `EditorStatus` (type)

### `src/lib/canvas.ts` - 184 lines
- `EditorAdjustments` (interface): blur, brightness, contrast, saturation
- `EditorTransform` (interface): flipH, flipV, rotation, zoom
- `CropRect` (interface): height, width, x, y
- `ExportOptions` (interface): format, quality
- `renderImage` (function)
- `computeCenteredCrop` (function)
- `exportCanvasToBlob` (function)
- `generateExportFilename` (function)
- `DEFAULT_ADJUSTMENTS` (const): blur, brightness, contrast, saturation
- `DEFAULT_TRANSFORM` (const): flipH, flipV, rotation, zoom
- `ASPECT_RATIOS` (const)

### `src/lib/validation.ts` - 49 lines
- `ValidationResult` (interface): error, valid
- `validateImageFile` (function)
- `SUPPORTED_TYPES` (const)
- `SUPPORTED_EXTENSIONS` (const)
- `MAX_FILE_SIZE` (const)

## Unresolved references

- (none) - every internal import resolves.
