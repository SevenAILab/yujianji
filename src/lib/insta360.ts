"use client";

import { Capacitor, CapacitorHttp, registerPlugin } from "@capacitor/core";
import { useEffect, useSyncExternalStore } from "react";
import { getOscNativeBridge } from "./osc";
import { isPanoramaDimensions } from "./image";

export const CAMERA_ADDRESS = "http://192.168.42.1";
export type CameraSession = { name: string; address: string };
let session: CameraSession | null = null;
let busy = false;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export function useInsta360() {
  useEffect(() => {
    const check = async () => {
      const current = session;
      if (!current || busy || document.visibilityState !== "visible") return;
      busy = true;
      try { await probe(current.address); }
      catch { if (session === current) disconnectInsta360(); }
      finally { busy = false; }
    };
    const timer = window.setInterval(() => void check(), 15000);
    const onOffline = () => disconnectInsta360();
    window.addEventListener("offline", onOffline);
    return () => { window.clearInterval(timer); window.removeEventListener("offline", onOffline); };
  }, []);
  return useSyncExternalStore(subscribe, () => session, () => null);
}
export function disconnectInsta360() { session = null; listeners.forEach((listener) => listener()); }

export function cameraAddress(input: string): string {
  const url = new URL(input.includes("://") ? input : `http://${input}`);
  const privateIp = /^(192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})$/;
  if (url.protocol !== "http:" || !privateIp.test(url.hostname) || url.hostname.split(".").some((part) => +part > 255) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("请输入相机的局域网 HTTP 地址，例如 192.168.42.1");
  }
  return url.origin;
}

async function request(address: string, path: string, body?: object): Promise<Record<string, any>> {
  if (!Capacitor.isNativePlatform() && typeof location !== "undefined" && location.protocol === "https:") {
    throw new Error("当前 HTTPS 网页无法访问相机 HTTP 热点，请使用原生 App。");
  }
  const base = cameraAddress(address);
  if (isAndroidCameraHost() && base !== CAMERA_ADDRESS) throw new Error("Android 当前仅支持相机默认地址 192.168.42.1");
  const url = `${base}${path}`;
  let payload;
  if (Capacitor.isNativePlatform()) {
    const bridge = getOscNativeBridge();
    if (body && bridge) {
      const response = await bridge.execute({ url, body: JSON.stringify(body), timeoutMs: 15000 });
      if (!response.ok) throw new Error(`相机请求失败：${response.status}`);
      payload = JSON.parse(response.body);
    } else {
      const response = await CapacitorHttp.request({ url, method: body ? "POST" : "GET", headers: { "Content-Type": "application/json" }, data: body, responseType: "json", connectTimeout: 8000, readTimeout: 15000, disableRedirects: true });
      if (response.status < 200 || response.status >= 300) throw new Error(`相机请求失败：${response.status}`);
      payload = typeof response.data === "string" ? JSON.parse(response.data) : response.data;
    }
  } else {
    const response = await fetch(url, { method: body ? "POST" : "GET", headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000), redirect: "error" });
    if (!response.ok) throw new Error(`相机请求失败：${response.status}`);
    payload = await response.json();
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("相机返回了无效响应");
  if (payload.error || payload.state === "error") throw new Error(payload.error?.message || "相机命令执行失败");
  return payload;
}

async function command(address: string, name: string, parameters: object = {}) {
  let result = await request(address, "/osc/commands/execute", { name, parameters });
  const deadline = Date.now() + 90000;
  const id = result.id;
  while (result.state === "inProgress" && Date.now() < deadline) {
    if (typeof id !== "string" || !id) throw new Error("相机没有返回拍摄任务编号");
    await new Promise((resolve) => setTimeout(resolve, 1000));
    result = await request(address, "/osc/commands/status", { id });
  }
  if (result.state !== "done") throw new Error("相机操作未完成，请检查相机后重试；不会自动重复拍照。");
  return result.results ?? {};
}

async function probe(address: string): Promise<CameraSession> {
  const info = await request(address, "/osc/info");
  if (typeof info.model !== "string" || !/insta360|arashi/i.test(`${info.model} ${info.manufacturer ?? ""}`)) throw new Error("该地址没有返回 Insta360 相机信息");
  const state = await request(address, "/osc/state", {});
  if (!state.state || typeof state.state !== "object") throw new Error("未取得相机状态");
  return { name: info.model, address };
}

export async function connectInsta360(input: string) {
  if (busy) throw new Error("相机正在处理上一项操作");
  busy = true;
  disconnectInsta360();
  try {
    session = await probe(cameraAddress(input));
    listeners.forEach((listener) => listener());
    return session;
  } finally { busy = false; }
}

export function captureFileUrl(address: string, result: Record<string, any>): URL {
  if (Array.isArray(result._fileGroup) && result._fileGroup.length > 1) throw new Error("相机返回了未拼接的多张原片，请在 Insta360 App 中拼接。");
  if (typeof result.fileUrl !== "string") throw new Error("相机未返回本次照片地址");
  const url = new URL(result.fileUrl, address);
  if (url.origin !== address || !/\.(jpe?g|png)$/i.test(url.pathname) || url.username || url.password) throw new Error("相机返回的照片地址或格式不受支持");
  return url;
}

export async function captureInsta360(onProgress: (message: string) => void): Promise<File> {
  if (!session) throw new Error("请先在设备页连接 Insta360");
  if (busy) throw new Error("相机正在处理上一项操作");
  busy = true;
  const current = session;
  try {
    onProgress("正在确认相机连接…");
    try { await probe(current.address); } catch (error) { disconnectInsta360(); throw error; }
    onProgress("正在准备全景拍摄…");
    const { options } = await command(current.address, "camera.getOptions", { optionNames: ["photoStitchingSupport", "photoStitching"] });
    if (!Array.isArray(options?.photoStitchingSupport) || !options.photoStitchingSupport.includes("ondevice")) throw new Error("此相机或固件未提供机内拼接，应用目前没有自动拼接后端，请先用 Insta360 App 处理。");
    await command(current.address, "camera.setOptions", { options: { captureMode: "image", photoStitching: "ondevice" } });
    onProgress("正在拍摄并拼接全景照片，请勿断开 Wi-Fi…");
    const result = await command(current.address, "camera.takePicture");
    const url = captureFileUrl(current.address, result);
    onProgress("正在下载本次全景照片…");
    let blob: Blob;
    if (Capacitor.isNativePlatform()) {
      const response = await CapacitorHttp.get({ url: url.href, responseType: "arraybuffer", connectTimeout: 8000, readTimeout: 60000, disableRedirects: true });
      if (response.status !== 200 || typeof response.data !== "string") throw new Error("照片下载失败");
      if (response.data.length > 90_000_000) throw new Error("照片过大，请使用 Insta360 App 处理");
      const bytes = Uint8Array.from(atob(response.data), (char) => char.charCodeAt(0));
      blob = new Blob([bytes], { type: /\.png$/i.test(url.pathname) ? "image/png" : "image/jpeg" });
    } else {
      const response = await fetch(url.href, { signal: AbortSignal.timeout(60000), redirect: "error" });
      if (!response.ok) throw new Error("照片下载失败");
      blob = await response.blob();
    }
    if (blob.size > 64 * 1024 * 1024) throw new Error("照片过大，请使用 Insta360 App 处理");
    const image = await createImageBitmap(blob);
    const panoramic = isPanoramaDimensions(image.width, image.height);
    image.close();
    if (!panoramic) throw new Error("下载的图片不是可展示的 2:1 全景照片，请在 Insta360 App 中检查拼接结果。");
    return new File([blob], url.pathname.split("/").pop() || "insta360.jpg", { type: /\.png$/i.test(url.pathname) ? "image/png" : "image/jpeg" });
  } finally { busy = false; }
}

export function cameraError(error: unknown): string {
  if (error instanceof TypeError || (error instanceof Error && error.name === "TimeoutError")) return "无法访问相机，请确认已连接相机 Wi-Fi、允许本地网络访问。网页还可能受跨域限制，请在原生 App 中重试。";
  return error instanceof Error ? error.message : "相机操作失败，请重试";
}

const cameraPlugin = registerPlugin<{ openWifiSettings(): Promise<void>; openInsta360(): Promise<void> }>("YujianjiCamera");
export function isAndroidCameraHost() { return Capacitor.isNativePlatform() && Capacitor.getPlatform() === "android"; }
export async function openCameraWifiSettings() {
  if (!isAndroidCameraHost()) throw new Error("请打开手机系统设置，进入 Wi-Fi 并选择相机热点。");
  await cameraPlugin.openWifiSettings();
}
export async function openInsta360App() {
  if (!isAndroidCameraHost()) throw new Error("请手动打开 Insta360 App，连接相机后进入相册管理。");
  await cameraPlugin.openInsta360();
}
