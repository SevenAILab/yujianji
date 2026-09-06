export const MIN_PANORAMA_ZOOM = 0.1;
export const MAX_PANORAMA_ZOOM = 3;
export const PANORAMA_EXIT_ZOOM = 0.075;
export const PREVIEW_PAUSE_MS = 3000;

export function panoramaZoom(value: number) {
  return {
    zoom: Math.max(MIN_PANORAMA_ZOOM, Math.min(MAX_PANORAMA_ZOOM, value)),
    exit: value <= PANORAMA_EXIT_ZOOM,
  };
}

export function globeRotationStep(elapsed: number, zoom: number, velocity: number, paused: boolean) {
  if (paused) return 0;
  return Math.min(50, Math.max(0, elapsed)) * 0.006 / Math.max(1, zoom) + velocity;
}
