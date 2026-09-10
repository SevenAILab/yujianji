"use client";

/**
 * 公众号扫码进来的读者，绝大多数是在微信内置浏览器里打开的。
 * 那个环境有几件事和普通浏览器不一样，而且都是静默失败：
 *
 * - 下载被拦：<a download> 点了没反应，「导出备份」会像坏掉一样
 * - 无法「添加到主屏幕」，也就拿不到持久化存储
 * - 不支持 Web Speech API，语音输入用不了
 *
 * 与其让人以为产品坏了，不如直说，并告诉他们怎么绕开。
 */
export type BrowserKind = "wechat" | "in-app" | "standard";

export function detectBrowser(): BrowserKind {
  if (typeof navigator === "undefined") return "standard";
  const ua = navigator.userAgent;
  if (/MicroMessenger/i.test(ua)) return "wechat";
  // 其他常见的应用内浏览器，下载同样不可靠。
  if (/(QQ\/|Weibo|DingTalk|Feishu|Lark|Alipay)/i.test(ua)) return "in-app";
  return "standard";
}

export function canDownloadFiles(kind: BrowserKind = detectBrowser()): boolean {
  return kind === "standard";
}

export function openInBrowserHint(kind: BrowserKind = detectBrowser()): string {
  if (kind === "wechat") {
    return "点右上角「···」→「在浏览器中打开」";
  }
  if (kind === "in-app") {
    return "用系统浏览器打开这个页面";
  }
  return "";
}

/** 判断是否已经作为独立应用运行（加到主屏幕后启动）。 */
export function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  try {
    if (window.matchMedia?.("(display-mode: standalone)").matches) return true;
    return (window.navigator as { standalone?: boolean }).standalone === true;
  } catch {
    return false;
  }
}
