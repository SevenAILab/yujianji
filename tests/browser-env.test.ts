import { afterEach, describe, expect, it, vi } from "vitest";
import { canDownloadFiles, detectBrowser, openInBrowserHint } from "../src/lib/browser-env";

function withUserAgent(ua: string) {
  vi.stubGlobal("navigator", { userAgent: ua });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const WECHAT_IOS =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.49(0x18003128) NetType/WIFI Language/zh_CN";
const WECHAT_ANDROID =
  "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0.0.0 Mobile Safari/537.36 MMWEBID/1234 MicroMessenger/8.0.49.2600(0x28003137)";
const SAFARI_IOS =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

describe("识别运行环境", () => {
  it("认出微信内置浏览器（iOS 和安卓）", () => {
    withUserAgent(WECHAT_IOS);
    expect(detectBrowser()).toBe("wechat");
    withUserAgent(WECHAT_ANDROID);
    expect(detectBrowser()).toBe("wechat");
  });

  it("认出其他应用内浏览器", () => {
    withUserAgent("Mozilla/5.0 ... QQ/8.9.0");
    expect(detectBrowser()).toBe("in-app");
    withUserAgent("Mozilla/5.0 ... AlipayClient/10.3");
    expect(detectBrowser()).toBe("in-app");
  });

  it("普通浏览器不误判", () => {
    withUserAgent(SAFARI_IOS);
    expect(detectBrowser()).toBe("standard");
  });

  it("只有普通浏览器才认为能下载文件", () => {
    // 微信会静默拦下 <a download>，导出备份点了不会有反应
    expect(canDownloadFiles("wechat")).toBe(false);
    expect(canDownloadFiles("in-app")).toBe(false);
    expect(canDownloadFiles("standard")).toBe(true);
  });

  it("给出对应的绕开方式", () => {
    expect(openInBrowserHint("wechat")).toContain("在浏览器中打开");
    expect(openInBrowserHint("in-app")).toContain("系统浏览器");
    expect(openInBrowserHint("standard")).toBe("");
  });
});
