import { describe, expect, it } from "vitest";
import { globeRotationStep, panoramaZoom, PREVIEW_PAUSE_MS } from "../src/lib/viewer-gestures";

describe("panorama and globe gestures", () => {
  it("zooms the image in, shrinks it to a small sphere, then exits only past the minimum", () => {
    expect(panoramaZoom(2)).toEqual({ zoom: 2, exit: false });
    expect(panoramaZoom(.3)).toEqual({ zoom: .3, exit: false });
    expect(panoramaZoom(.09)).toEqual({ zoom: .1, exit: false });
    expect(panoramaZoom(.07)).toEqual({ zoom: .1, exit: true });
    expect(panoramaZoom(5)).toEqual({ zoom: 3, exit: false });
  });
  it("can enlarge a small sphere back into the panorama without exiting", () => {
    for (const value of [.1, .3, .8, 1, 2]) expect(panoramaZoom(value).exit).toBe(false);
  });
  it("freezes both rotation and inertia for the preview and resumes after three seconds", () => {
    const shownAt = 1000;
    expect(globeRotationStep(16, 4, .4, 3999 < shownAt + PREVIEW_PAUSE_MS)).toBe(0);
    expect(globeRotationStep(16, 4, 0, 4000 < shownAt + PREVIEW_PAUSE_MS)).toBeGreaterThan(0);
  });
  it("keeps automatic screen motion stable when zoomed and avoids jumps after backgrounding", () => {
    expect(globeRotationStep(16, 4, 0, false) * 4).toBeCloseTo(globeRotationStep(16, 1, 0, false));
    expect(globeRotationStep(60000, 1, 0, false)).toBeLessThan(1);
  });
});
