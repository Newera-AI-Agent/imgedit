'use client';

import { useImageEditor } from '@/hooks/useImageEditor';
import EmptyState from '@/components/EmptyState';

export default function Home() {
  const { state, loadImage, clearError } = useImageEditor();

  return (
    <div className="flex flex-col flex-1 bg-[#0f0f1a] font-sans min-h-screen">
      {/* Header */}
      <header className="border-b border-[#1e1e3a] px-6 py-4">
        <div className="max-w-5xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <svg
              className="w-7 h-7 text-cyan-400"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.5}
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
              <circle cx="8.5" cy="8.5" r="1.5" />
              <path d="M21 15l-5-5L5 21" />
            </svg>
            <h1 className="text-lg font-semibold text-[#e0e0e0] tracking-tight">
              imgedit
            </h1>
          </div>
          <span className="text-xs text-[#5a5a7a] font-medium">
            Client-side image editor
          </span>
        </div>
      </header>

      {/* Main content */}
      <main className="flex-1 flex flex-col items-center justify-center max-w-5xl mx-auto w-full px-4">
        {state.status === 'empty' || state.status === 'loading' || state.error ? (
          <EmptyState
            onFileSelect={loadImage}
            error={state.error}
            onClearError={clearError}
          />
        ) : state.status === 'ready' && state.image ? (
          <div className="flex flex-col items-center gap-6 w-full py-12">
            <div className="bg-[#1a1a2e] border border-[#2a2a4a] rounded-xl p-6 w-full max-w-2xl">
              <div className="flex items-center gap-4 mb-4">
                <div className="w-10 h-10 rounded-lg bg-cyan-500/10 flex items-center justify-center">
                  <svg
                    className="w-5 h-5 text-cyan-400"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={1.5}
                    aria-hidden="true"
                  >
                    <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                    <circle cx="8.5" cy="8.5" r="1.5" />
                    <path d="M21 15l-5-5L5 21" />
                  </svg>
                </div>
                <div>
                  <p className="text-[#e0e0e0] font-medium text-sm truncate max-w-xs">
                    {state.image.name}
                  </p>
                  <p className="text-[#5a5a7a] text-xs">
                    {state.image.width} × {state.image.height} px
                  </p>
                </div>
              </div>
              {/* Preview canvas area */}
              <div className="rounded-lg overflow-hidden bg-[#0f0f1a] border border-[#2a2a4a] flex items-center justify-center min-h-[300px]">
                <img
                  src={state.image.objectUrl}
                  alt={state.image.name}
                  className="max-w-full max-h-[500px] object-contain"
                  style={{
                    transform: `rotate(${state.transform.rotation}deg) scaleX(${state.transform.flipH ? -1 : 1}) scaleY(${state.transform.flipV ? -1 : 1}) scale(${state.transform.zoom})`,
                    filter: [
                      state.adjustments.brightness !== 0 ? `brightness(${100 + state.adjustments.brightness}%)` : '',
                      state.adjustments.contrast !== 0 ? `contrast(${100 + state.adjustments.contrast}%)` : '',
                      state.adjustments.saturation !== 0 ? `saturate(${100 + state.adjustments.saturation}%)` : '',
                      state.adjustments.blur > 0 ? `blur(${state.adjustments.blur}px)` : '',
                    ].filter(Boolean).join(' '),
                  }}
                />
              </div>
            </div>
            <p className="text-[#4a4a6a] text-sm text-center max-w-md">
              Image loaded successfully. The full editing toolbar (adjustments, crop, transform, export) is available
              in the complete editor workspace — this deployment verifies the core client-side pipeline.
            </p>
          </div>
        ) : state.status === 'processing' ? (
          <div className="flex items-center justify-center min-h-[400px] p-8">
            <div className="text-center">
              <div className="w-8 h-8 border-2 border-cyan-400/30 border-t-cyan-400 rounded-full animate-spin mx-auto mb-4" />
              <p className="text-[#6a6a8a] text-sm">Processing image…</p>
            </div>
          </div>
        ) : (
          <EmptyState
            onFileSelect={loadImage}
            error={state.error}
            onClearError={clearError}
          />
        )}
      </main>

      {/* Footer */}
      <footer className="border-t border-[#1e1e3a] px-6 py-3">
        <div className="max-w-5xl mx-auto flex items-center justify-between text-xs text-[#4a4a6a]">
          <span>Supports PNG, JPEG, WebP, BMP, TIFF · Up to 50 MB</span>
          <span>All processing happens in your browser</span>
        </div>
      </footer>
    </div>
  );
}
