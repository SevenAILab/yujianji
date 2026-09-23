import { execSync } from "node:child_process";
import type { NextConfig } from "next";

/**
 * 构建时记下 git commit，/api/health 回出来——自有服务器上没有 VERCEL_GIT_COMMIT_SHA，
 * 不记的话线上跑的到底是哪一版只能靠猜。不在 git 目录里构建就是空，不影响构建。
 */
function buildCommit(): string {
  try {
    return execSync("git rev-parse --short HEAD", { cwd: process.cwd(), stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return "";
  }
}

/**
 * CSP 先跑 Report-Only。地图（D3/TopoJSON）、全景（WebGL）、分享图（Canvas）
 * 大量用到 blob: 和 data:，直接上强制模式很容易打伤功能。
 * 观察一段时间违规报告确认干净后，把这里换成 Content-Security-Policy。
 */
const csp = [
  "default-src 'self'",
  // Next 的运行时需要 inline script；上 nonce 要改造整个 layout，这一版先不动。
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self' https: blob:",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

const nextConfig: NextConfig = {
  env: { BUILD_COMMIT: buildCommit() },
  turbopack: {
    ignoreIssue: [
      // 遇见手记服务端要按环境变量找 ffmpeg 和临时目录，Turbopack 会提示"动态文件访问导致整个项目被 trace"。
      // 只影响 output: "standalone" 的打包体积；本项目用 next start 部署，不受影响。
      { path: /src\/lib\/memo\/server\/(ffmpeg|tmp-store)\.ts$/, title: /Dynamic filesystem access/ },
    ],
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy-Report-Only", value: csp },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Frame-Options", value: "DENY" },
          {
            key: "Permissions-Policy",
            // 相机、定位、麦克风是产品要用的，留给自己；其余关掉。
            value:
              "camera=(self), geolocation=(self), microphone=(self), payment=(), usb=(), interest-cohort=()",
          },
        ],
      },
      {
        source: "/memory-universe/:path*",
        headers: [
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          { key: "Content-Security-Policy-Report-Only", value: csp.replace("frame-ancestors 'none'", "frame-ancestors 'self'") },
        ],
      },
      {
        // 接口一律不缓存，避免 CDN 把限流响应或健康状态缓存住。
        source: "/api/:path*",
        headers: [{ key: "Cache-Control", value: "no-store" }],
      },
    ];
  },
};

export default nextConfig;
