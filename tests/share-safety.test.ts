import { describe, expect, it } from "vitest";
import { decodeSharePayload, isSafeImageDataUrl } from "../src/lib/share";

const basePayload = {
  id: "x",
  name: "白色的叶子",
  category: "plant",
  place: "莫干山",
  country: "CHN",
  date: "2026-01-01T00:00:00Z",
  userNote: "第一次见",
  photo: "data:image/jpeg;base64,AAAA",
  ai: null,
};

function encode(payload: unknown): string {
  return encodeURIComponent(JSON.stringify(payload));
}

describe("分享链接里的图片白名单", () => {
  it("放行我们自己生成的 JPEG / PNG data URL", () => {
    expect(isSafeImageDataUrl("data:image/jpeg;base64,AAAA")).toBe(true);
    expect(isSafeImageDataUrl("data:image/png;base64,AAAA")).toBe(true);
  });

  it("拦下脚本、外链和 SVG", () => {
    expect(isSafeImageDataUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeImageDataUrl("https://example.com/a.jpg")).toBe(false);
    // SVG 能内嵌脚本，即使是 data URL 也不放行。
    expect(isSafeImageDataUrl("data:image/svg+xml;base64,AAAA")).toBe(false);
    expect(isSafeImageDataUrl(null)).toBe(false);
    expect(isSafeImageDataUrl(123)).toBe(false);
  });

  it("解码时把不合法的图片清空，但保留文字内容", () => {
    const decoded = decodeSharePayload(
      encode({ ...basePayload, photo: "javascript:alert(1)" }),
    );
    expect(decoded).not.toBeNull();
    expect(decoded?.photo).toBe("");
    expect(decoded?.name).toBe("白色的叶子");
  });

  it("合法图片原样保留", () => {
    const decoded = decodeSharePayload(encode(basePayload));
    expect(decoded?.photo).toBe("data:image/jpeg;base64,AAAA");
  });

  it("结构不对时整条返回 null", () => {
    expect(decodeSharePayload(encode({ name: "只有名字" }))).toBeNull();
    expect(decodeSharePayload("不是-json")).toBeNull();
  });
});
