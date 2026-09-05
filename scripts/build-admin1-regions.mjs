import { readFile, writeFile } from "node:fs/promises";

const sourcePath = process.argv[2];
const outputPath = process.argv[3] ?? "src/data/admin1-regions.json";

if (!sourcePath) {
  throw new Error("Usage: node scripts/build-admin1-regions.mjs <Natural Earth GeoJSON> [output]");
}

const source = JSON.parse(await readFile(sourcePath, "utf8"));
const defaultTolerance = 0.055;

function perpendicularDistance(point, start, end) {
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  if (dx === 0 && dy === 0) return Math.hypot(point[0] - start[0], point[1] - start[1]);
  const t = Math.max(0, Math.min(1, ((point[0] - start[0]) * dx + (point[1] - start[1]) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(point[0] - (start[0] + t * dx), point[1] - (start[1] + t * dy));
}

function simplifyOpen(points, tolerance) {
  if (points.length <= 3) return points;
  let furthest = 0;
  let index = 0;
  for (let i = 1; i < points.length - 1; i += 1) {
    const distance = perpendicularDistance(points[i], points[0], points.at(-1));
    if (distance > furthest) {
      furthest = distance;
      index = i;
    }
  }
  if (furthest <= tolerance) return [points[0], points.at(-1)];
  return [...simplifyOpen(points.slice(0, index + 1), tolerance).slice(0, -1), ...simplifyOpen(points.slice(index), tolerance)];
}

function simplifyRing(ring) {
  const source = ring.slice(0, -1);
  const lngs = source.map((point) => point[0]);
  const lats = source.map((point) => point[1]);
  const span = Math.max(Math.max(...lngs) - Math.min(...lngs), Math.max(...lats) - Math.min(...lats));
  const tolerance = span < 0.2 ? 0.0015 : span < 1 ? 0.006 : defaultTolerance;
  const simplified = simplifyOpen(source, tolerance);
  const rounded = simplified.map(([lng, lat]) => [Number(lng.toFixed(4)), Number(lat.toFixed(4))]);
  if (rounded.length < 3) return null;
  rounded.push([...rounded[0]]);
  return rounded;
}

function signedArea(ring) {
  let area = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    area += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  }
  return area / 2;
}

function simplifyPolygon(polygon) {
  return polygon.map(simplifyRing).filter(Boolean).map((ring, index) => {
    // D3 spherical geometry needs clockwise exterior rings and counter-clockwise holes.
    const shouldReverse = index === 0 ? signedArea(ring) > 0 : signedArea(ring) < 0;
    return shouldReverse ? [...ring].reverse() : ring;
  });
}

function simplifyGeometry(geometry) {
  if (geometry.type === "Polygon") {
    return { type: "Polygon", coordinates: simplifyPolygon(geometry.coordinates) };
  }
  return {
    type: "MultiPolygon",
    coordinates: geometry.coordinates.map(simplifyPolygon).filter((polygon) => polygon.length),
  };
}

const regions = source.features
  .filter((feature) => feature.geometry?.coordinates)
  .map((feature) => ({
    id: feature.properties.iso_3166_2 || feature.properties.adm1_code,
    country: feature.properties.adm0_a3,
    name: feature.properties.name_en || feature.properties.name,
    nameZh: feature.properties.name_zh || feature.properties.name,
    center: [feature.properties.longitude, feature.properties.latitude],
    bbox: feature.bbox,
    geometry: simplifyGeometry(feature.geometry),
  }))
  .filter((region) => region.id && region.country && region.geometry.coordinates.length);

await writeFile(outputPath, `${JSON.stringify(regions)}\n`);
console.log(`Wrote ${regions.length} regions to ${outputPath}`);
