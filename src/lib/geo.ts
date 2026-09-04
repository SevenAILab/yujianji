export interface Position {
  lat: number;
  lng: number;
}

export type PositionFailure =
  | "unsupported"
  | "denied"
  | "timeout"
  | "unavailable";

export interface PositionResult {
  position: Position | null;
  failure: PositionFailure | null;
}

export function getPosition(): Promise<PositionResult> {
  if (typeof navigator === "undefined" || !navigator.geolocation) {
    return Promise.resolve({ position: null, failure: "unsupported" });
  }

  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (position) =>
        resolve({
          position: {
            lat: position.coords.latitude,
            lng: position.coords.longitude,
          },
          failure: null,
        }),
      (error) => {
        const failure =
          error.code === error.PERMISSION_DENIED
            ? "denied"
            : error.code === error.TIMEOUT
              ? "timeout"
              : "unavailable";
        resolve({ position: null, failure });
      },
      { enableHighAccuracy: false, timeout: 10_000, maximumAge: 300_000 },
    );
  });
}
