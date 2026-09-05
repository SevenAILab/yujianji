const MAX_DATA_URL_BYTES = 2 * 1024 * 1024;

export type PreparedImage = {
  dataUrl: string;
  width: number;
  height: number;
};

export function isPanoramaDimensions(width: number, height: number): boolean {
  if (width < 1024 || height < 512) return false;
  const ratio = width / height;
  return ratio >= 1.9 && ratio <= 2.1;
}

export async function prepareImage(file: File): Promise<PreparedImage> {
  if (!file.type.startsWith("image/")) {
    throw new Error("请选择图片文件");
  }

  const bitmap = await createImageBitmap(file);
  const width = bitmap.width;
  const height = bitmap.height;
  const maxSide = 1280;
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const context = canvas.getContext("2d");

  if (!context) {
    throw new Error("无法处理这张图片");
  }

  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();

  let quality = 0.8;
  let dataUrl = canvas.toDataURL("image/jpeg", quality);
  while (dataUrl.length > MAX_DATA_URL_BYTES && quality > 0.45) {
    quality -= 0.08;
    dataUrl = canvas.toDataURL("image/jpeg", quality);
  }

  if (dataUrl.length > MAX_DATA_URL_BYTES) {
    throw new Error("图片压缩后仍超过 2MB，请换一张图片");
  }

  return { dataUrl, width, height };
}

export async function compressImage(file: File): Promise<string> {
  return (await prepareImage(file)).dataUrl;
}

export function dataUrlByteLength(dataUrl: string): number {
  const base64 = dataUrl.split(",")[1] ?? "";
  return Math.floor((base64.length * 3) / 4);
}
