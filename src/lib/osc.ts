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

export function normalizeOscBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  if (!trimmed) return DEFAULT_OSC_BASE_URL;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `http://${trimmed}`;
}

export function isSecureContextForOsc(): boolean {
  return typeof window !== "undefined" && window.location.protocol === "https:";
}

async function oscPost(
  baseUrl: string,
  name: string,
  parameters: Record<string, unknown> = {},
): Promise<OscCommandResponse> {
  const response = await fetch(`${normalizeOscBaseUrl(baseUrl)}/osc/commands/execute`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({ name, parameters }),
  });

  const payload = (await response.json().catch(() => ({}))) as OscCommandResponse;
  if (!response.ok) {
    throw new Error(payload.error?.message || `OSC 请求失败：${response.status}`);
  }
  if (payload.error) {
    throw new Error(payload.error.message || "OSC 命令执行失败");
  }
  return payload;
}

export async function oscGetState(baseUrl: string): Promise<OscCommandResponse> {
  return oscPost(baseUrl, "camera.getState");
}

export async function oscTakePicture(baseUrl: string): Promise<OscCommandResponse> {
  return oscPost(baseUrl, "camera.takePicture");
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