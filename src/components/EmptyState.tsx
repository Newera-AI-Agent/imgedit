'use client';

import { useCallback, useRef, useState, type DragEvent, type ChangeEvent } from 'react';

interface EmptyStateProps {
  onFileSelect: (file: File) => void;
  error: string | null;
  onClearError: () => void;
}

export default function EmptyState({ onFileSelect, error, onClearError }: EmptyStateProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  const handleDragOver = useCallback((e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragging(false);
  }, []);

  const handleDrop = useCallback((e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragging(false);
    const files = e.dataTransfer.files;
    if (files.length > 0) {
      onFileSelect(files[0]);
    }
  }, [onFileSelect]);

  const handleClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFileChange = useCallback((e: ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files && files.length > 0) {
      onFileSelect(files[0]);
    }
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  }, [onFileSelect]);

  if (error) {
    return (
      <div className="flex items-center justify-center min-h-[400px] p-8">
        <div className="bg-red-900/20 border border-red-500/30 rounded-xl p-8 max-w-md w-full text-center">
          <svg className="w-12 h-12 mx-auto mb-4 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z" />
          </svg>
          <h3 className="text-red-300 font-semibold text-lg mb-2">Import Error</h3>
          <p className="text-red-200/80 text-sm mb-4">{error}</p>
          <button
            onClick={onClearError}
            className="px-4 py-2 bg-red-500/20 hover:bg-red-500/30 text-red-300 rounded-lg transition-colors text-sm font-medium focus:outline-none focus-visible:ring-2 focus-visible:ring-red-400"
          >
            Try again
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      className={`flex items-center justify-center min-h-[400px] p-8 ${
        dragging ? 'bg-cyan-500/5' : ''
      }`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <button
        onClick={handleClick}
        className={`
          w-full max-w-lg p-12 rounded-2xl border-2 border-dashed
          transition-all duration-200 cursor-pointer
          focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 focus-visible:ring-offset-2 focus-visible:ring-offset-[#0f0f1a]
          ${
            dragging
              ? 'border-cyan-400 bg-cyan-500/10 scale-[1.01]'
              : 'border-[#2a2a4a] bg-[#1a1a2e]/50 hover:border-[#3a3a5a] hover:bg-[#1a1a2e]/80'
          }
        `}
        aria-label="Open file picker to load an image"
      >
        <svg className="w-16 h-16 mx-auto mb-4 text-[#4a4a6a]" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" />
        </svg>
        <h2 className="text-xl font-semibold text-[#e0e0e0] mb-2">
          Drop an image or click to browse
        </h2>
        <p className="text-sm text-[#6a6a8a]">
          Supports PNG, JPEG, WebP, BMP, TIFF • Up to 50 MB
        </p>
      </button>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/bmp,image/tiff"
        onChange={handleFileChange}
        className="hidden"
        aria-hidden="true"
      />
    </div>
  );
}
