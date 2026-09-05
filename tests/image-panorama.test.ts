import { describe, expect, it } from "vitest";
import { isPanoramaDimensions } from "../src/lib/image";

describe("panorama dimensions", () => {
  it("recognizes the supplied 2:1 equirectangular image", () => {
    expect(isPanoramaDimensions(8000, 4000)).toBe(true);
    expect(isPanoramaDimensions(4096, 2048)).toBe(true);
  });

  it("does not mark ordinary photos as panoramas", () => {
    expect(isPanoramaDimensions(4032, 3024)).toBe(false);
    expect(isPanoramaDimensions(1170, 2532)).toBe(false);
  });
});
