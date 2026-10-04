// 飞书妙记「文字记录」解析（外部设备接入工单 v2 Gate 1，纯函数，服务端和测试共用）。
//
// 数据来源（2026-10-03 用 Seven 的真实妙记实测）：妙记 → 纪要 note → verbatim_doc_token → docx raw_content。
// raw_content 的样子：
//   文字记录：<标题> 2026年10月2日
//   录音主题：<标题>
//   录音时间：2026年10月2日（周五） 16:52 - 18:04 （GMT+08）
//   智能纪要：<标题> 2026年10月2日
//
//   说话人 1 00:00:01
//   你点了？
//
//   @seven 00:00:02
//   点了。
// - 妙记接口的 create_time 是"同步到飞书的时间"，不是开录时间（9/30 17:50 录的，显示 10/1 16:27），所以开录时间只认「录音时间」这一行。
// - 「@名字」是飞书认出来的飞书用户；6 条里只有 1 条认出了 Seven 本人，所以它只当加分，定"我"仍靠响度。
// - 每段只有开始时间（精确到秒），结束时间取下一段的开始；长段按句末标点切开，时间按字数比例分。

export interface FeishuRecordingTime {
  /** ISO，带原始时区偏移换算成 UTC */
  startedAt: string;
  endedAt: string;
  /** 分钟，GMT+08 → 480 */
  tzOffsetMin: number;
}

export interface FeishuTurn {
  /** 原样的说话人标签：「说话人 1」「@seven」 */
  label: string;
  /** 稳定的说话人 id（只含字母数字下划线）：s1 / u_seven */
  speakerId: string;
  /** 是否是飞书认出来的用户（@名字） */
  named: boolean;
  beginMs: number;
  text: string;
}

export interface ParsedVerbatim {
  recording: FeishuRecordingTime | null;
  turns: FeishuTurn[];
}

const RECORDING_LINE = /录音时间[：:]\s*(\d{4})年(\d{1,2})月(\d{1,2})日[^\d\n]*?(\d{1,2}):(\d{2})\s*[-–—~至]\s*(?:(\d{4})年(\d{1,2})月(\d{1,2})日[^\d\n]*?)?(\d{1,2}):(\d{2})\s*[（(]\s*(?:GMT|UTC)\s*([+-])(\d{1,2})(?::?(\d{2}))?\s*[）)]/;
const TURN_HEADER = /^(.{1,60}?)\s+(\d{1,2}):(\d{2}):(\d{2})$/;

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** 本地时间 + 偏移 → UTC ISO */
function toIso(y: number, m: number, d: number, hh: number, mm: number, offsetMin: number): string {
  const utc = Date.UTC(y, m - 1, d, hh, mm) - offsetMin * 60_000;
  return new Date(utc).toISOString();
}

export function parseRecordingTime(text: string): FeishuRecordingTime | null {
  const m = RECORDING_LINE.exec(text);
  if (!m) return null;
  const [y, mo, d, h1, m1] = [m[1], m[2], m[3], m[4], m[5]].map(Number);
  const [y2, mo2, d2] = m[6] ? [Number(m[6]), Number(m[7]), Number(m[8])] : [y, mo, d];
  const [h2, m2] = [Number(m[9]), Number(m[10])];
  const sign = m[11] === "-" ? -1 : 1;
  const tzOffsetMin = sign * (Number(m[12]) * 60 + Number(m[13] ?? 0));
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h1 > 23 || m1 > 59 || h2 > 23 || m2 > 59 || Math.abs(tzOffsetMin) > 14 * 60) return null;
  const startedAt = toIso(y, mo, d, h1, m1, tzOffsetMin);
  let endedAt = toIso(y2, mo2, d2, h2, m2, tzOffsetMin);
  // 跨零点且没写结束日期：结束时间早于开始 → 算第二天
  if (!m[6] && Date.parse(endedAt) < Date.parse(startedAt)) endedAt = new Date(Date.parse(endedAt) + 86_400_000).toISOString();
  return { startedAt, endedAt, tzOffsetMin };
}

export function speakerIdFor(label: string): { speakerId: string; named: boolean } {
  const anonymous = /^说话人\s*(\d+)$/.exec(label) ?? /^speaker\s*(\d+)$/i.exec(label);
  if (anonymous) return { speakerId: `s${anonymous[1]}`, named: false };
  const name = label.replace(/^@/, "").trim().toLowerCase();
  // 只留字母数字；中文名转成码点，保证稳定且不含分隔符
  const slug = [...name].map((ch) => (/[a-z0-9]/.test(ch) ? ch : ch.codePointAt(0)!.toString(36))).join("").slice(0, 40) || "unknown";
  return { speakerId: `u_${slug}`, named: label.startsWith("@") };
}

export function parseVerbatim(raw: string): ParsedVerbatim {
  const lines = raw.replace(/\r\n?/g, "\n").split("\n");
  const turns: FeishuTurn[] = [];
  let current: FeishuTurn | null = null;
  let started = false;
  for (const line of lines) {
    const trimmed = line.trim();
    const header = TURN_HEADER.exec(trimmed);
    // 头部那几行（录音主题、录音时间……）不会匹配段落头：段落头必须以 HH:MM:SS 结尾
    if (header && !/[：:]\S/.test(header[1].slice(0, 6))) {
      if (current && current.text) turns.push(current);
      const label = header[1].trim();
      const { speakerId, named } = speakerIdFor(label);
      const beginMs = ((Number(header[2]) * 60 + Number(header[3])) * 60 + Number(header[4])) * 1000;
      current = { label, speakerId, named, beginMs, text: "" };
      started = true;
      continue;
    }
    if (!started || !current || !trimmed) continue;
    current.text = current.text ? `${current.text}${/[A-Za-z0-9]$/.test(current.text) ? " " : ""}${trimmed}` : trimmed;
  }
  if (current && current.text) turns.push(current);
  turns.sort((a, b) => a.beginMs - b.beginMs);
  return { recording: parseRecordingTime(raw), turns };
}

/** 把一段话按句末标点切开；太短的碎句并回前一句 */
export function splitSentences(text: string): string[] {
  const parts = text.match(/[^。！？!?；;…]+[。！？!?；;…]*|[。！？!?；;…]+/g) ?? [text];
  const out: string[] = [];
  for (const part of parts.map((p) => p.trim()).filter(Boolean)) {
    if (out.length && part.replace(/[。！？!?；;…\s]/g, "").length < 2) out[out.length - 1] += part;
    else out.push(part);
  }
  return out.length ? out : [text];
}

export interface TimedFeishuSentence {
  beginMs: number;
  endMs: number;
  speakerId: string;
  speakerKey: string;
  text: string;
  partIndex: 0;
}

/**
 * 段 → 句子时间轴。段的结束 = 下一段的开始（最后一段 = 音频时长）；段内按字数比例分配。
 * durationMs 拿不到时，最后一段按每字 250 毫秒估一个结束时间。
 */
export function turnsToSentences(turns: FeishuTurn[], durationMs: number | null): TimedFeishuSentence[] {
  const out: TimedFeishuSentence[] = [];
  turns.forEach((turn, i) => {
    const next = turns[i + 1];
    const fallbackEnd = turn.beginMs + Math.max(1_000, turn.text.length * 250);
    let end = next ? next.beginMs : durationMs && durationMs > turn.beginMs ? durationMs : fallbackEnd;
    if (end <= turn.beginMs) end = turn.beginMs + 1_000;
    const pieces = splitSentences(turn.text);
    const total = pieces.reduce((sum, p) => sum + Math.max(1, p.length), 0);
    let cursor = turn.beginMs;
    pieces.forEach((piece, j) => {
      const share = j === pieces.length - 1 ? end - cursor : Math.round(((end - turn.beginMs) * Math.max(1, piece.length)) / total);
      const beginMs = cursor;
      const endMs = Math.max(beginMs + 1, Math.min(end, cursor + share));
      out.push({ beginMs, endMs, speakerId: turn.speakerId, speakerKey: `0:${turn.speakerId}`, text: piece, partIndex: 0 });
      cursor = endMs;
    });
  });
  return out;
}

/** 飞书认出来的、和授权用户同名的说话人 → "我"。名字对不上就不猜。 */
export function ownerSpeakerKeys(turns: FeishuTurn[], ownerNames: string[]): string[] {
  const names = new Set(ownerNames.map((n) => n.trim().toLowerCase()).filter(Boolean));
  if (!names.size) return [];
  const keys = new Set<string>();
  for (const turn of turns) {
    if (turn.named && names.has(turn.label.replace(/^@/, "").trim().toLowerCase())) keys.add(`0:${turn.speakerId}`);
  }
  return [...keys];
}

/** 显示用：本地时间 HH:MM */
export function localClock(iso: string, tzOffsetMin: number): string {
  const d = new Date(Date.parse(iso) + tzOffsetMin * 60_000);
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}
