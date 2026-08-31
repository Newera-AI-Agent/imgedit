'use client';

import { useReducer, useCallback, useRef, useEffect } from 'react';
import type {
  EditorAdjustments,
  EditorTransform,
  CropRect,
} from '../lib/canvas';
import {
  DEFAULT_ADJUSTMENTS,
  DEFAULT_TRANSFORM,
  computeCenteredCrop,
} from '../lib/canvas';
import { validateImageFile, formatFileSize } from '../lib/validation';

// ── Types ──

export type EditorStatus =
  | 'empty'
  | 'loading'
  | 'ready'
  | 'processing'
  | 'export-success'
  | 'export-error';

export interface EditorImage {
  file: File;
  objectUrl: string;
  element: HTMLImageElement;
  width: number;
  height: number;
  name: string;
}

export interface EditorState {
  status: EditorStatus;
  image: EditorImage | null;
  adjustments: EditorAdjustments;
  transform: EditorTransform;
  crop: CropRect | null;
  cropAspectRatio: number;
  cropMode: boolean;
  error: string | null;
  exportMessage: string | null;
  undoStack: Snapshot[];
  redoStack: Snapshot[];
}

interface Snapshot {
  adjustments: EditorAdjustments;
  transform: EditorTransform;
  crop: CropRect | null;
  cropAspectRatio: number;
}

type EditorAction =
  | { type: 'START_LOAD' }
  | { type: 'LOAD_SUCCESS'; image: EditorImage }
  | { type: 'LOAD_ERROR'; error: string }
  | { type: 'SET_ADJUSTMENT'; key: keyof EditorAdjustments; value: number }
  | { type: 'RESET_ADJUSTMENTS' }
  | { type: 'SET_TRANSFORM'; transform: Partial<EditorTransform> }
  | { type: 'RESET_TRANSFORM' }
  | { type: 'SET_ROTATION'; degrees: number }
  | { type: 'FLIP_H' }
  | { type: 'FLIP_V' }
  | { type: 'SET_ZOOM'; zoom: number }
  | { type: 'TOGGLE_CROP_MODE' }
  | { type: 'SET_CROP_ASPECT_RATIO'; ratio: number }
  | { type: 'APPLY_CROP' }
  | { type: 'RESET_ALL' }
  | { type: 'UNDO' }
  | { type: 'REDO' }
  | { type: 'SET_STATUS'; status: EditorStatus }
  | { type: 'SET_EXPORT_MESSAGE'; message: string | null }
  | { type: 'CLEAR_ERROR' };

// ── Reducer ──

function takeSnapshot(state: EditorState): Snapshot {
  return {
    adjustments: { ...state.adjustments },
    transform: { ...state.transform },
    crop: state.crop ? { ...state.crop } : null,
    cropAspectRatio: state.cropAspectRatio,
  };
}

function editorReducer(state: EditorState, action: EditorAction): EditorState {
  switch (action.type) {
    case 'START_LOAD':
      return { ...state, status: 'loading', error: null };

    case 'LOAD_SUCCESS': {
      const { image } = action;
      const crop: CropRect = { x: 0, y: 0, width: image.width, height: image.height };
      return {
        ...state,
        status: 'ready',
        image,
        adjustments: { ...DEFAULT_ADJUSTMENTS },
        transform: { ...DEFAULT_TRANSFORM },
        crop,
        cropAspectRatio: 0,
        cropMode: false,
        error: null,
        exportMessage: null,
        undoStack: [],
        redoStack: [],
      };
    }

    case 'LOAD_ERROR':
      return { ...state, status: 'empty', error: action.error };

    case 'SET_ADJUSTMENT': {
      const snapshot = takeSnapshot(state);
      return {
        ...state,
        adjustments: { ...state.adjustments, [action.key]: action.value },
        undoStack: [...state.undoStack, snapshot],
        redoStack: [],
      };
    }

    case 'RESET_ADJUSTMENTS': {
      const snapshot = takeSnapshot(state);
      return {
        ...state,
        adjustments: { ...DEFAULT_ADJUSTMENTS },
        undoStack: [...state.undoStack, snapshot],
        redoStack: [],
      };
    }

    case 'SET_TRANSFORM': {
      const snapshot = takeSnapshot(state);
      return {
        ...state,
        transform: { ...state.transform, ...action.transform },
        undoStack: [...state.undoStack, snapshot],
        redoStack: [],
      };
    }

    case 'RESET_TRANSFORM': {
      const snapshot = takeSnapshot(state);
      return {
        ...state,
        transform: { ...DEFAULT_TRANSFORM },
        undoStack: [...state.undoStack, snapshot],
        redoStack: [],
      };
    }

    case 'SET_ROTATION': {
      const snapshot = takeSnapshot(state);
      return {
        ...state,
        transform: { ...state.transform, rotation: action.degrees },
        undoStack: [...state.undoStack, snapshot],
        redoStack: [],
      };
    }

    case 'FLIP_H': {
      const snapshot = takeSnapshot(state);
      return {
        ...state,
        transform: { ...state.transform, flipH: !state.transform.flipH },
        undoStack: [...state.undoStack, snapshot],
        redoStack: [],
      };
    }

    case 'FLIP_V': {
      const snapshot = takeSnapshot(state);
      return {
        ...state,
        transform: { ...state.transform, flipV: !state.transform.flipV },
        undoStack: [...state.undoStack, snapshot],
        redoStack: [],
      };
    }

    case 'SET_ZOOM': {
      const snapshot = takeSnapshot(state);
      return {
        ...state,
        transform: { ...state.transform, zoom: action.zoom },
        undoStack: [...state.undoStack, snapshot],
        redoStack: [],
      };
    }

    case 'TOGGLE_CROP_MODE': {
      if (state.cropMode) {
        // Exiting crop mode without applying — revert
        return { ...state, cropMode: false };
      }
      return { ...state, cropMode: true };
    }

    case 'SET_CROP_ASPECT_RATIO': {
      if (!state.image) return state;
      const newCrop = computeCenteredCrop(
        state.image.width,
        state.image.height,
        action.ratio
      );
      return {
        ...state,
        cropAspectRatio: action.ratio,
        crop: newCrop,
      };
    }

    case 'APPLY_CROP': {
      if (!state.crop) return state;
      const snapshot = takeSnapshot(state);
      return {
        ...state,
        cropMode: false,
        undoStack: [...state.undoStack, snapshot],
        redoStack: [],
      };
    }

    case 'RESET_ALL': {
      if (!state.image) return state;
      const snapshot = takeSnapshot(state);
      return {
        ...state,
        adjustments: { ...DEFAULT_ADJUSTMENTS },
        transform: { ...DEFAULT_TRANSFORM },
        crop: { x: 0, y: 0, width: state.image.width, height: state.image.height },
        cropAspectRatio: 0,
        cropMode: false,
        undoStack: [...state.undoStack, snapshot],
        redoStack: [],
      };
    }

    case 'UNDO': {
      if (state.undoStack.length === 0) return state;
      const prev = state.undoStack[state.undoStack.length - 1];
      const redoSnapshot = takeSnapshot(state);
      return {
        ...state,
        ...prev,
        undoStack: state.undoStack.slice(0, -1),
        redoStack: [...state.redoStack, redoSnapshot],
      };
    }

    case 'REDO': {
      if (state.redoStack.length === 0) return state;
      const next = state.redoStack[state.redoStack.length - 1];
      const undSnapshot = takeSnapshot(state);
      return {
        ...state,
        ...next,
        redoStack: state.redoStack.slice(0, -1),
        undoStack: [...state.undoStack, undSnapshot],
      };
    }

    case 'SET_STATUS':
      return { ...state, status: action.status };

    case 'SET_EXPORT_MESSAGE':
      return { ...state, exportMessage: action.message };

    case 'CLEAR_ERROR':
      return { ...state, error: null };

    default:
      return state;
  }
}

// ── Initial State ──

const initialState: EditorState = {
  status: 'empty',
  image: null,
  adjustments: { ...DEFAULT_ADJUSTMENTS },
  transform: { ...DEFAULT_TRANSFORM },
  crop: null,
  cropAspectRatio: 0,
  cropMode: false,
  error: null,
  exportMessage: null,
  undoStack: [],
  redoStack: [],
};

// ── Hook ──

export function useImageEditor() {
  const [state, dispatch] = useReducer(editorReducer, initialState);
  const objectUrlRef = useRef<string | null>(null);

  // Cleanup object URLs on unmount
  useEffect(() => {
    return () => {
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current);
        objectUrlRef.current = null;
      }
    };
  }, []);

  // Cleanup old object URL when image changes
  useEffect(() => {
    if (state.image?.objectUrl) {
      if (
        objectUrlRef.current &&
        objectUrlRef.current !== state.image.objectUrl
      ) {
        URL.revokeObjectURL(objectUrlRef.current);
      }
      objectUrlRef.current = state.image.objectUrl;
    }
  }, [state.image?.objectUrl]);

  const loadImage = useCallback((file: File) => {
    const validation = validateImageFile(file);
    if (!validation.valid) {
      dispatch({ type: 'LOAD_ERROR', error: validation.error ?? 'Invalid file' });
      return;
    }

    dispatch({ type: 'START_LOAD' });

    const objectUrl = URL.createObjectURL(file);
    const img = new window.Image();

    img.onload = () => {
      const editorImage: EditorImage = {
        file,
        objectUrl,
        element: img,
        width: img.naturalWidth,
        height: img.naturalHeight,
        name: file.name,
      };
      dispatch({ type: 'LOAD_SUCCESS', image: editorImage });
    };

    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      dispatch({
        type: 'LOAD_ERROR',
        error: 'Failed to load image. The file may be corrupted or in an unsupported format.',
      });
    };

    img.src = objectUrl;
  }, []);

  const setAdjustment = useCallback(
    (key: keyof EditorAdjustments, value: number) => {
      dispatch({ type: 'SET_ADJUSTMENT', key, value });
    },
    []
  );

  const resetAdjustments = useCallback(() => {
    dispatch({ type: 'RESET_ADJUSTMENTS' });
  }, []);

  const resetTransform = useCallback(() => {
    dispatch({ type: 'RESET_TRANSFORM' });
  }, []);

  const setRotation = useCallback((degrees: number) => {
    dispatch({ type: 'SET_ROTATION', degrees });
  }, []);

  const flipH = useCallback(() => {
    dispatch({ type: 'FLIP_H' });
  }, []);

  const flipV = useCallback(() => {
    dispatch({ type: 'FLIP_V' });
  }, []);

  const setZoom = useCallback((zoom: number) => {
    dispatch({ type: 'SET_ZOOM', zoom });
  }, []);

  const toggleCropMode = useCallback(() => {
    dispatch({ type: 'TOGGLE_CROP_MODE' });
  }, []);

  const setCropAspectRatio = useCallback((ratio: number) => {
    dispatch({ type: 'SET_CROP_ASPECT_RATIO', ratio });
  }, []);

  const applyCrop = useCallback(() => {
    dispatch({ type: 'APPLY_CROP' });
  }, []);

  const resetAll = useCallback(() => {
    dispatch({ type: 'RESET_ALL' });
  }, []);

  const undo = useCallback(() => {
    dispatch({ type: 'UNDO' });
  }, []);

  const redo = useCallback(() => {
    dispatch({ type: 'REDO' });
  }, []);

  const setStatus = useCallback((status: EditorStatus) => {
    dispatch({ type: 'SET_STATUS', status });
  }, []);

  const setExportMessage = useCallback((message: string | null) => {
    dispatch({ type: 'SET_EXPORT_MESSAGE', message });
  }, []);

  const clearError = useCallback(() => {
    dispatch({ type: 'CLEAR_ERROR' });
  }, []);

  return {
    state,
    loadImage,
    setAdjustment,
    resetAdjustments,
    resetTransform,
    setRotation,
    flipH,
    flipV,
    setZoom,
    toggleCropMode,
    setCropAspectRatio,
    applyCrop,
    resetAll,
    undo,
    redo,
    setStatus,
    setExportMessage,
    clearError,
  };
}
