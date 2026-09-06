import { Capacitor, registerPlugin } from "@capacitor/core";

export const DEFAULT_OSC_BASE_URL = "http://192.168.42.1";

export interface OscCommandResponse {
  name?: string;
  state?: string;
  id?: string;
  fingerprint?: string;
  _latestFileUrl?: string;
  _captureStatus?: string;
  results?: Record<string, unknown>;
  entries?: OscFileEntry[];
  totalEntries?: number;
  error?: {
    code?: string;
    message?: string;
  };
}

export interface OscFileEntry {
  name?: string;
  fileUrl?: string;
  size?: number;
  dateTimeZone?: string;
  width?: number;
  height?: number;
  thumbnail?: string;
}

export interface OscNativeBridgePlugin {
  execute(options: {
    url: string;
    body: string;
    timeoutMs?: number;
  }): Promise<{ status: number; body: string; ok: boolean }>;
}

let oscBridge: OscNativeBridgePlugin | null = null;

function getOscNativeBridge(): OscNativeBridgePlugin | null {
  if (typeof window === "undefined") return null;
  if (!Capacitor.isNativePlatform()) return null;
  if (!oscBridge) {
    oscBridge = registerPlugin<OscNativeBridgePlugin>("YujianjiOsc");
  }
  return oscBridge;
}

export function normalizeOscBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  if (!trimmed) return DEFAULT_OSC_BASE_URL;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `http://${trimmed}`;
}

export function isSecureContextForOsc(): boolean {
  return typeof window !== "undefined" && window.location.protocol === "https:";
}

function parseOscPayload(body: string, status: number): OscCommandResponse {
  let payload: OscCommandResponse = {};
  try {
    payload = body ? (JSON.parse(body) as OscCommandResponse) : {};
  } catch {
    payload = {};
  }
  if (status < 200 || status > 299) {
    throw new Error(payload.error?.message || `OSC 请求失败：${status}`);
  }
  if (payload.error) {
    throw new Error(payload.error.message || "OSC 命令执行失败");
  }
  return payload;
}

async function oscPost(
  baseUrl: string,
  name: string,
  parameters: Record<string, unknown> = {},
): Promise<OscCommandResponse> {
  const url = `${normalizeOscBaseUrl(baseUrl)}/osc/commands/execute`;
  const body = JSON.stringify({ name, parameters });
  const nativeBridge = getOscNativeBridge();

  if (nativeBridge) {
    const result = await nativeBridge.execute({ url, body, timeoutMs: 20_000 });
    return parseOscPayload(result.body, result.status);
  }

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body,
  });
  const text = await response.text();
  return parseOscPayload(text, response.status);
}

export async function oscGetState(baseUrl: string): Promise<OscCommandResponse> {
  return oscPost(baseUrl, "camera.getState");
}

export async function oscTakePicture(baseUrl: string): Promise<OscCommandResponse> {
  return oscPost(baseUrl, "camera.takePicture");
}

export async function oscStartCapture(baseUrl: string): Promise<OscCommandResponse> {
  return oscPost(baseUrl, "camera.startCapture");
}

export async function oscStopCapture(baseUrl: string): Promise<OscCommandResponse> {
  return oscPost(baseUrl, "camera.stopCapture");
}

export async function oscListFiles(
  baseUrl: string,
  entryCount = 20,
  maxThumbSize = 0,
): Promise<OscFileEntry[]> {
  const payload = await oscPost(baseUrl, "camera.listFiles", {
    entryCount,
    maxThumbSize,
  });
  return payload.entries ?? [];
}

export async function oscWaitForCapture(
  baseUrl: string,
  timeoutMs = 20000,
): Promise<OscCommandResponse> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const state = await oscGetState(baseUrl);
    if (state._latestFileUrl || state._captureStatus === "done") {
      return state;
    }
    await new Promise((resolve) => window.setTimeout(resolve, 1200));
  }
  throw new Error("等待相机拍摄完成超时，请在设备页查看最新文件。");
}
