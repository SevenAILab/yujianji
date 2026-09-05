"use client";

import { useEffect, useRef } from "react";

type CutoutMode = "subject" | "polaroid";

function colorDistance(data: Uint8ClampedArray, index: number, color: [number, number, number]) {
  const dr = data[index] - color[0];
  const dg = data[index + 1] - color[1];
  const db = data[index + 2] - color[2];
  return Math.sqrt(dr * dr * .8 + dg * dg + db * db * 1.15);
}

function averagePatch(data: Uint8ClampedArray, width: number, height: number, cx: number, cy: number, radius: number): [number, number, number] {
  let r = 0, g = 0, b = 0, count = 0;
  for (let y = Math.max(0, cy - radius); y < Math.min(height, cy + radius); y += 2) {
    for (let x = Math.max(0, cx - radius); x < Math.min(width, cx + radius); x += 2) {
      const index = (y * width + x) * 4;
      r += data[index]; g += data[index + 1]; b += data[index + 2]; count += 1;
    }
  }
  return [r / count, g / count, b / count];
}

function floodRegion(data: Uint8ClampedArray, width: number, height: number, seeds: number[], reference: [number, number, number], threshold: number) {
  const selected = new Uint8Array(width * height);
  const queued = new Uint8Array(width * height);
  const queue = new Int32Array(width * height);
  let head = 0, tail = 0;
  for (const seed of seeds) {
    if (!queued[seed]) { queue[tail++] = seed; queued[seed] = 1; }
  }
  while (head < tail) {
    const pixel = queue[head++];
    if (colorDistance(data, pixel * 4, reference) > threshold) continue;
    selected[pixel] = 1;
    const x = pixel % width;
    const y = (pixel / width) | 0;
    const neighbors = [x > 0 ? pixel - 1 : -1, x < width - 1 ? pixel + 1 : -1, y > 0 ? pixel - width : -1, y < height - 1 ? pixel + width : -1];
    for (const next of neighbors) {
      if (next >= 0 && !queued[next]) { queued[next] = 1; queue[tail++] = next; }
    }
  }
  return selected;
}

export function SmartPhotoCutout({ src, alt, mode }: { src: string; alt: string; mode: CutoutMode }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (mode === "polaroid") return;
    let cancelled = false;
    const image = new Image();
    image.decoding = "async";
    image.src = src;
    image.onload = () => {
      if (cancelled || !canvasRef.current) return;
      const scale = Math.min(1, 760 / image.naturalWidth);
      const width = Math.max(1, Math.round(image.naturalWidth * scale));
      const height = Math.max(1, Math.round(image.naturalHeight * scale));
      const source = document.createElement("canvas");
      source.width = width; source.height = height;
      const sourceContext = source.getContext("2d", { willReadFrequently: true });
      if (!sourceContext) return;
      sourceContext.drawImage(image, 0, 0, width, height);
      const pixels = sourceContext.getImageData(0, 0, width, height);

      const subject = averagePatch(pixels.data, width, height, Math.round(width * .5), Math.round(height * .5), Math.max(12, Math.round(width * .055)));
      const center = Math.round(height * .5) * width + Math.round(width * .5);
      const foreground = floodRegion(pixels.data, width, height, [center], subject, 108);

      let minX = width, minY = height, maxX = 0, maxY = 0;
      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          const pixel = y * width + x;
          const index = pixel * 4;
          if (!foreground[pixel]) pixels.data[index + 3] = 0;
          else { minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); }
        }
      }
      sourceContext.putImageData(pixels, 0, 0);

      const pad = 13;
      const output = canvasRef.current;
      output.width = Math.max(1, maxX - minX + 1 + pad * 2);
      output.height = Math.max(1, maxY - minY + 1 + pad * 2);
      const context = output.getContext("2d");
      if (!context) return;
      const offsetX = pad - minX;
      const offsetY = pad - minY;

      context.save();
      context.fillStyle = "#fff8e8";
      for (let angle = 0; angle < Math.PI * 2; angle += Math.PI / 18) {
        const radius = 6.5 + Math.sin(angle * 11) * 1.8;
        context.drawImage(source, offsetX + Math.cos(angle) * radius, offsetY + Math.sin(angle) * radius);
      }
      context.globalCompositeOperation = "source-in";
      context.fillRect(0, 0, output.width, output.height);
      context.restore();
      context.drawImage(source, offsetX, offsetY);
    };
    return () => { cancelled = true; };
  }, [mode, src]);

  if (mode === "polaroid") {
    return <span className="smart-polaroid"><img src={src} alt={alt} /></span>;
  }

  return <canvas ref={canvasRef} className="smart-cutout-canvas" role="img" aria-label={alt} />;
}

