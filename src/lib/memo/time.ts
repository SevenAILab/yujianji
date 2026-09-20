// 时间与时区：一律存 UTC ISO，显示和 dayKey 按会话时区算（跨时区旅行时不会把晚上的片段算到第二天）。

export const DEFAULT_TIME_ZONE = "Asia/Shanghai";

export function isValidTimeZone(timeZone: string | undefined): timeZone is string {
  if (!timeZone) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

export function deviceTimeZone(): string {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return isValidTimeZone(tz) ? tz : DEFAULT_TIME_ZONE;
  } catch {
    return DEFAULT_TIME_ZONE;
  }
}

function parts(iso: string, timeZone: string): Record<string, string> {
  const tz = isValidTimeZone(timeZone) ? timeZone : DEFAULT_TIME_ZONE;
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const out: Record<string, string> = {};
  for (const part of formatter.formatToParts(new Date(iso))) out[part.type] = part.value;
  return out;
}

/** 会话时区里的本地日期 YYYY-MM-DD */
export function dayKeyIn(iso: string, timeZone: string): string {
  const p = parts(iso, timeZone);
  return `${p.year}-${p.month}-${p.day}`;
}

/** 会话时区里的 HH:mm */
export function clockIn(iso: string, timeZone: string): string {
  const p = parts(iso, timeZone);
  return `${p.hour}:${p.minute}`;
}

/** 该时刻在时区里相对 UTC 的分钟偏移（东八区 = 480） */
export function tzOffsetMinutes(iso: string, timeZone: string): number {
  const p = parts(iso, timeZone);
  const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
  const actual = new Date(iso);
  actual.setUTCMilliseconds(0);
  return Math.round((asUtc - actual.getTime()) / 60_000);
}

export function addMs(iso: string, ms: number): string {
  return new Date(new Date(iso).getTime() + ms).toISOString();
}

export function isDayKey(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

/** "9/22" 这种给用户看的短日期 */
export function shortDay(dayKey: string): string {
  const [, m, d] = dayKey.split("-");
  return `${Number(m)}/${Number(d)}`;
}
