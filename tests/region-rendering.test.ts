import { geoOrthographic, geoPath } from "d3-geo";
import { describe, expect, it } from "vitest";
import { getAdmin1Region } from "../src/lib/admin1";

describe("Admin-1 globe geometry", () => {
  it("renders Fujian as a local region, not the globe complement", () => {
    const fujian = getAdmin1Region("CN-FJ");
    expect(fujian).not.toBeNull();

    const radius = 240;
    const projection = geoOrthographic()
      .translate([300, 300])
      .scale(radius)
      .rotate([-fujian!.center[0], -fujian!.center[1], 0])
      .clipAngle(90);
    const path = geoPath(projection);
    const regionArea = path.area({
      type: "Feature",
      properties: {},
      geometry: fujian!.geometry,
    } as never);
    const globeArea = Math.PI * radius * radius;

    expect(regionArea).toBeGreaterThan(1);
    expect(regionArea).toBeLessThan(globeArea * 0.05);
  });

  it("centers Hesse using the same projection used by the wireframe", () => {
    const hesse = getAdmin1Region("DE-HE");
    expect(hesse).not.toBeNull();
    const projection = geoOrthographic()
      .translate([300, 300])
      .scale(240)
      .rotate([-hesse!.center[0], -hesse!.center[1], 0]);

    const projected = projection(hesse!.center);
    expect(projected?.[0]).toBeCloseTo(300, 5);
    expect(projected?.[1]).toBeCloseTo(300, 5);
  });
});
