import type { Category, Item } from "./types";

export interface SharePayload {
  id: string;
  name: string;
  category: Category;
  place: string;
  country: string;
  date: string;
  userNote: string;
  heard?: string;
  photo: string;
  ai: {
    cognition: string;
    fun: string;
    luckText: string;
    luckBasis: string;
    question: string;
    memorySentence: string;
    verdict: "first" | "reunion";
  } | null;
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("照片加载失败"));
    image.src = src;
  });
}

async function makeThumbnail(src: string): Promise<string> {
  try {
    const image = await loadImage(src);
    const size = 320;
    const ratio = Math.min(size / image.width, size / image.height);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.width * ratio));
    canvas.height = Math.max(1, Math.round(image.height * ratio));
    const context = canvas.getContext("2d");
    if (!context) return "";
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.72);
  } catch {
    return "";
  }
}

export async function buildSharePayload(item: Item): Promise<SharePayload> {
  return {
    id: item.id,
    name: item.name,
    category: item.category,
    place: item.place,
    country: item.country,
    date: item.date,
    userNote: item.userNote,
    heard: item.heard,
    photo: await makeThumbnail(item.photo),
    ai: item.ai
      ? {
          cognition: item.ai.cognition,
          fun: item.ai.fun,
          luckText: item.ai.luck.text,
          luckBasis: item.ai.luck.basis,
          question: item.ai.question,
          memorySentence: item.ai.memorySentence,
          verdict: item.ai.verdict,
        }
      : null,
  };
}

/**
 * 分享链接里的内容全部来自 URL，也就是来自任何人。
 * 图片必须是我们自己生成的那种 JPEG/PNG data URL —— 别的一律丢弃，
 * 免得把 `javascript:` 之类的东西直接塞进 <img src>。
 */
export function isSafeImageDataUrl(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^data:image\/(?:jpeg|png);base64,[A-Za-z0-9+/=]+$/.test(value)
  );
}

export function encodeSharePayload(payload: SharePayload): string {
  return encodeURIComponent(JSON.stringify(payload));
}

export function decodeSharePayload(encoded: string): SharePayload | null {
  try {
    const parsed = JSON.parse(decodeURIComponent(encoded)) as SharePayload;
    if (
      !parsed ||
      typeof parsed.id !== "string" ||
      typeof parsed.name !== "string" ||
      typeof parsed.category !== "string" ||
      typeof parsed.place !== "string" ||
      typeof parsed.date !== "string" ||
      typeof parsed.photo !== "string"
    ) {
      return null;
    }
    // 不是合法图片就把它清空：整条记录的文字仍然可读，只是不显示图。
    if (!isSafeImageDataUrl(parsed.photo)) parsed.photo = "";
    return parsed;
  } catch {
    return null;
  }
}

export function buildShareUrl(payload: SharePayload): string {
  return `${window.location.origin}/share#${encodeSharePayload(payload)}`;
}
