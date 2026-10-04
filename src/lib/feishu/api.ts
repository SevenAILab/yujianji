// 飞书开放平台：只调固定的几个接口路径（外部设备接入工单 v2 Gate 1）。
//
// 安全约束：
// - 不做任意代理：每个函数对应一个写死的路径，路径参数先过白名单正则；
// - 用户令牌只在请求头里转发，不写日志、不落盘；
// - 应用密钥只在服务端（FEISHU_APP_ID / FEISHU_APP_SECRET）。
// 接口与返回结构 2026-10-03/04 用 Seven 的账号经 lark-cli 实测：
//   POST /open-apis/minutes/v1/minutes/search          （按同步时间搜妙记）
//   GET  /open-apis/minutes/v1/minutes/:token          （标题、时长、note_id）
//   GET  /open-apis/vc/v1/notes/:note_id               （verbatim_doc_token）
//   GET  /open-apis/docx/v1/documents/:id/raw_content  （文字记录全文）
//   GET  /open-apis/minutes/v1/minutes/:token/media    （音频下载链接，Ogg/Opus）

const OPEN_BASE = "https://open.feishu.cn";
const ACCOUNTS_BASE = "https://accounts.feishu.cn";

export const FEISHU_SCOPES = [
  "minutes:minutes:readonly",
  "minutes:minutes.basic:read",
  "minutes:minutes.search:read",
  "minutes:minutes.media:export",
  "vc:note:read",
  "docx:document:readonly",
  "offline_access",
] as const;

export const MINUTE_TOKEN_PATTERN = /^[a-z0-9]{16,40}$/;
const NOTE_ID_PATTERN = /^\d{6,30}$/;
const DOC_TOKEN_PATTERN = /^[A-Za-z0-9]{16,40}$/;

export type FeishuErrorCode =
  | "FEISHU_NOT_CONFIGURED"
  | "FEISHU_AUTH_EXPIRED"
  | "FEISHU_FORBIDDEN"
  | "FEISHU_NOT_FOUND"
  | "FEISHU_NOT_READY"
  | "FEISHU_RATE_LIMITED"
  | "FEISHU_ERROR"
  | "FEISHU_MEDIA_TOO_LARGE";

export class FeishuError extends Error {
  readonly code: FeishuErrorCode;
  readonly status: number;
  constructor(code: FeishuErrorCode, status: number, message: string) {
    super(message);
    this.name = "FeishuError";
    this.code = code;
    this.status = status;
  }
}

export function feishuAppConfig(): { appId: string; appSecret: string } {
  const appId = process.env.FEISHU_APP_ID?.trim() ?? "";
  const appSecret = process.env.FEISHU_APP_SECRET?.trim() ?? "";
  if (!appId || !appSecret) throw new FeishuError("FEISHU_NOT_CONFIGURED", 503, "服务器还没配置飞书应用（FEISHU_APP_ID / FEISHU_APP_SECRET）");
  return { appId, appSecret };
}

export function feishuConfigured(): boolean {
  return Boolean(process.env.FEISHU_APP_ID?.trim() && process.env.FEISHU_APP_SECRET?.trim());
}

/** 飞书的业务错误码 → 我们的错误。99991663/99991668/99991677 是令牌失效类；99991672/99991679 是权限不够 */
function mapFeishuError(httpStatus: number, code: number | undefined, msg: string | undefined): FeishuError {
  if (httpStatus === 401 || code === 99991663 || code === 99991668 || code === 99991677 || code === 20005 || code === 20037) {
    return new FeishuError("FEISHU_AUTH_EXPIRED", 401, "飞书授权过期了，请重新授权");
  }
  if (httpStatus === 403 || code === 99991672 || code === 99991679) return new FeishuError("FEISHU_FORBIDDEN", 403, "飞书授权的权限不够，请重新授权");
  if (httpStatus === 404) return new FeishuError("FEISHU_NOT_FOUND", 404, "飞书里找不到这条记录");
  if (httpStatus === 429 || code === 99991400) return new FeishuError("FEISHU_RATE_LIMITED", 429, "飞书接口限流，稍后再试");
  return new FeishuError("FEISHU_ERROR", 502, `飞书接口返回错误${code ? ` ${code}` : ""}${msg ? `：${msg.slice(0, 80)}` : ""}`);
}

async function openApi<T>(userToken: string, method: "GET" | "POST", path: string, opts: { query?: Record<string, string>; body?: unknown; timeoutMs?: number } = {}): Promise<T> {
  const url = new URL(path, OPEN_BASE);
  for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${userToken}`, ...(opts.body !== undefined ? { "Content-Type": "application/json; charset=utf-8" } : {}) },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
      redirect: "error",
    });
  } catch (error) {
    throw new FeishuError("FEISHU_ERROR", 502, `连不上飞书：${(error as Error)?.name ?? "网络错误"}`);
  }
  const json = (await res.json().catch(() => null)) as { code?: number; msg?: string; data?: T } | null;
  if (!res.ok || !json || json.code !== 0) throw mapFeishuError(res.status, json?.code, json?.msg);
  return (json.data ?? {}) as T;
}

// ── OAuth（授权码） ───────────────────────────────────────────────

export function authorizeUrl(input: { state: string; redirectUri: string }): string {
  const { appId } = feishuAppConfig();
  const url = new URL("/open-apis/authen/v1/authorize", ACCOUNTS_BASE);
  url.searchParams.set("client_id", appId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("scope", FEISHU_SCOPES.join(" "));
  url.searchParams.set("state", input.state);
  return url.toString();
}

export interface FeishuTokens {
  accessToken: string;
  refreshToken?: string;
  /** 毫秒时间戳 */
  expiresAt: number;
  refreshExpiresAt?: number;
  scope?: string;
}

async function tokenRequest(body: Record<string, string>): Promise<FeishuTokens> {
  const { appId, appSecret } = feishuAppConfig();
  let res: Response;
  try {
    res = await fetch(new URL("/open-apis/authen/v2/oauth/token", OPEN_BASE), {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ ...body, client_id: appId, client_secret: appSecret }),
      signal: AbortSignal.timeout(15_000),
      redirect: "error",
    });
  } catch {
    throw new FeishuError("FEISHU_ERROR", 502, "连不上飞书授权服务");
  }
  const json = (await res.json().catch(() => null)) as {
    code?: number;
    error?: string;
    error_description?: string;
    access_token?: string;
    expires_in?: number;
    refresh_token?: string;
    refresh_token_expires_in?: number;
    scope?: string;
  } | null;
  if (!res.ok || !json?.access_token || (json.code !== undefined && json.code !== 0)) {
    if (json?.error === "invalid_grant") throw new FeishuError("FEISHU_AUTH_EXPIRED", 401, "飞书授权过期了，请重新授权");
    throw new FeishuError("FEISHU_ERROR", 502, `飞书授权失败${json?.error ? `：${json.error}` : ""}`);
  }
  const now = Date.now();
  return {
    accessToken: json.access_token,
    ...(json.refresh_token ? { refreshToken: json.refresh_token } : {}),
    expiresAt: now + (json.expires_in ?? 7_200) * 1000,
    ...(json.refresh_token_expires_in ? { refreshExpiresAt: now + json.refresh_token_expires_in * 1000 } : {}),
    ...(json.scope ? { scope: json.scope } : {}),
  };
}

export function exchangeCode(code: string, redirectUri: string): Promise<FeishuTokens> {
  return tokenRequest({ grant_type: "authorization_code", code, redirect_uri: redirectUri });
}

export function refreshTokens(refreshToken: string): Promise<FeishuTokens> {
  return tokenRequest({ grant_type: "refresh_token", refresh_token: refreshToken });
}

export async function userInfo(userToken: string): Promise<{ name: string; enName?: string; openId?: string }> {
  const data = await openApi<{ name?: string; en_name?: string; open_id?: string }>(userToken, "GET", "/open-apis/authen/v1/user_info");
  return { name: data.name ?? "", ...(data.en_name ? { enName: data.en_name } : {}), ...(data.open_id ? { openId: data.open_id } : {}) };
}

// ── 妙记 ─────────────────────────────────────────────────────────

export interface MinuteListItem {
  token: string;
  title: string;
  /** 飞书展示用的说明（含"开始时间"——注意那是同步时间） */
  description: string;
}

export async function searchMinutes(userToken: string, input: { startIso: string; endIso: string; pageToken?: string }): Promise<{ items: MinuteListItem[]; pageToken?: string; hasMore: boolean }> {
  const data = await openApi<{
    items?: { token?: string; display_info?: string; meta_data?: { description?: string } }[];
    has_more?: boolean;
    page_token?: string;
  }>(userToken, "POST", "/open-apis/minutes/v1/minutes/search", {
    query: { page_size: "30", ...(input.pageToken ? { page_token: input.pageToken } : {}) },
    body: { filter: { create_time: { start_time: input.startIso, end_time: input.endIso } } },
  });
  const items = (data.items ?? [])
    .filter((item): item is { token: string; display_info?: string; meta_data?: { description?: string } } => typeof item.token === "string" && MINUTE_TOKEN_PATTERN.test(item.token))
    .map((item) => ({
      token: item.token,
      title: (item.display_info ?? "").split("\n")[0].replace(/<[^>]+>|&lt;[^&]*&gt;/g, "").slice(0, 120) || "（无标题）",
      description: (item.meta_data?.description ?? "").slice(0, 200),
    }));
  return { items, hasMore: Boolean(data.has_more), ...(data.page_token ? { pageToken: data.page_token } : {}) };
}

export interface MinuteInfo {
  token: string;
  title: string;
  durationMs: number | null;
  noteId: string | null;
  /** 同步到飞书的时间（不是开录时间） */
  syncedAt: string | null;
}

export async function getMinute(userToken: string, minuteToken: string): Promise<MinuteInfo> {
  if (!MINUTE_TOKEN_PATTERN.test(minuteToken)) throw new FeishuError("FEISHU_NOT_FOUND", 400, "妙记标识不正确");
  const data = await openApi<{ minute?: { title?: string; duration?: string; note_id?: string; create_time?: string } }>(userToken, "GET", `/open-apis/minutes/v1/minutes/${minuteToken}`);
  const m = data.minute ?? {};
  const duration = Number(m.duration);
  const created = Number(m.create_time);
  return {
    token: minuteToken,
    title: (m.title ?? "").slice(0, 120),
    durationMs: Number.isFinite(duration) && duration > 0 ? duration : null,
    noteId: m.note_id && NOTE_ID_PATTERN.test(m.note_id) ? m.note_id : null,
    syncedAt: Number.isFinite(created) && created > 0 ? new Date(created).toISOString() : null,
  };
}

export async function verbatimDocToken(userToken: string, noteId: string): Promise<string> {
  if (!NOTE_ID_PATTERN.test(noteId)) throw new FeishuError("FEISHU_NOT_FOUND", 400, "纪要标识不正确");
  const data = await openApi<{ note?: { verbatim_doc_token?: string } }>(userToken, "GET", `/open-apis/vc/v1/notes/${noteId}`);
  const token = data.note?.verbatim_doc_token;
  if (!token || !DOC_TOKEN_PATTERN.test(token)) throw new FeishuError("FEISHU_NOT_READY", 409, "飞书还在整理这段录音的文字记录，稍后再试");
  return token;
}

export async function docRawContent(userToken: string, docToken: string): Promise<string> {
  if (!DOC_TOKEN_PATTERN.test(docToken)) throw new FeishuError("FEISHU_NOT_FOUND", 400, "文档标识不正确");
  const data = await openApi<{ content?: string }>(userToken, "GET", `/open-apis/docx/v1/documents/${docToken}/raw_content`, { timeoutMs: 20_000 });
  return data.content ?? "";
}

/** 音频下载链接（飞书给的临时链接，现取现用，不缓存） */
export async function mediaUrl(userToken: string, minuteToken: string): Promise<string> {
  if (!MINUTE_TOKEN_PATTERN.test(minuteToken)) throw new FeishuError("FEISHU_NOT_FOUND", 400, "妙记标识不正确");
  const data = await openApi<{ download_url?: string }>(userToken, "GET", `/open-apis/minutes/v1/minutes/${minuteToken}/media`);
  const url = data.download_url;
  if (!url) throw new FeishuError("FEISHU_NOT_READY", 409, "飞书还没准备好这段录音的音频");
  const host = new URL(url).hostname;
  // 只下载飞书自己的域名（实测是 internal-api-drive-stream.feishu.cn）
  if (!/(^|\.)feishu\.cn$|(^|\.)feishucdn\.com$|(^|\.)larksuite\.com$/.test(host)) throw new FeishuError("FEISHU_ERROR", 502, "音频链接不是飞书的地址");
  return url;
}
