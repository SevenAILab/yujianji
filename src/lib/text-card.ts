"use client";

function wrapText(
  context: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  maxLines: number,
): string[] {
  const characters = [...text.trim()];
  const lines: string[] = [];
  let current = "";
  for (const character of characters) {
    const next = `${current}${character}`;
    if (context.measureText(next).width > maxWidth && current) {
      lines.push(current);
      current = character;
      if (lines.length === maxLines - 1) break;
    } else {
      current = next;
    }
  }
  if (current && lines.length < maxLines) lines.push(current);
  return lines;
}

export function createTextCardDataUrl(text: string): string {
  const canvas = document.createElement("canvas");
  canvas.width = 1080;
  canvas.height = 810;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("浏览器无法生成文字卡片");

  context.fillStyle = "#dcefeb";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "#2f6f6a";
  context.fillRect(64, 64, 8, 160);
  context.fillStyle = "#163f42";
  context.font = "700 58px system-ui, sans-serif";
  context.fillText("只写字，也算一次遇见", 104, 134);
  context.fillStyle = "#49686d";
  context.font = "42px system-ui, sans-serif";
  const lines = wrapText(context, text, 860, 6);
  lines.forEach((line, index) => {
    context.fillText(line, 104, 280 + index * 72);
  });
  return canvas.toDataURL("image/jpeg", 0.82);
}
