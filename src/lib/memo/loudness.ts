// 响度：8kHz 单声道 s16le PCM，对每个说话人所有句子时段算 RMS 转 dB，按时长加权平均（spec §4.3）。

export interface TimedSentence {
  speakerKey: string;
  /** 相对会话开始（已加分段 offset） */
  beginMs: number;
  endMs: number;
}

export function rmsDb(samples: Int16Array, from: number, to: number): number | null {
  const a = Math.max(0, Math.floor(from));
  const b = Math.min(samples.length, Math.floor(to));
  if (b - a <= 0) return null;
  let sum = 0;
  for (let i = a; i < b; i += 1) sum += samples[i] * samples[i];
  const rms = Math.sqrt(sum / (b - a)) / 32768;
  return 20 * Math.log10(rms + 1e-9);
}

export function speakerLoudness(
  samples: Int16Array,
  sampleRate: number,
  sentences: TimedSentence[],
): { key: string; meanDb: number | null; talkMs: number }[] {
  const acc = new Map<string, { weighted: number; measuredMs: number; talkMs: number }>();
  for (const s of sentences) {
    const ms = Math.max(0, s.endMs - s.beginMs);
    const entry = acc.get(s.speakerKey) ?? { weighted: 0, measuredMs: 0, talkMs: 0 };
    entry.talkMs += ms;
    const db = rmsDb(samples, (s.beginMs / 1000) * sampleRate, (s.endMs / 1000) * sampleRate);
    if (db !== null && ms > 0) {
      entry.weighted += db * ms;
      entry.measuredMs += ms;
    }
    acc.set(s.speakerKey, entry);
  }
  return [...acc].map(([key, v]) => ({
    key,
    meanDb: v.measuredMs > 0 ? Math.round((v.weighted / v.measuredMs) * 10) / 10 : null,
    talkMs: v.talkMs,
  }));
}
