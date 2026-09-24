"use client";

// 过零点后第一次打开：把前几天还没写（或写完又有新素材）的手帐补上，完成后轻提示一次。
// 用户还没同意隐私告知时不动（写手帐要调模型）；每次打开每天最多试一次，失败下次打开再试。
import Link from "next/link";
import { useEffect, useState } from "react";
import { LOCAL_ONLY } from "@/lib/app-mode";
import { isConsentCurrent, readConsent } from "@/lib/consent";
import { recentMaterials, staleDays } from "@/lib/memo/client/auto-diary";
import { generateDiary } from "@/lib/memo/client/orchestrator";
import { deviceTimeZone, shortDay } from "@/lib/memo/time";

const attempted = new Set<string>();
const NOTICE_MS = 6_000;

export function DiaryAutoGenerator() {
  const [written, setWritten] = useState<string | null>(null);

  useEffect(() => {
    if (LOCAL_ONLY) return;
    let cancelled = false;
    void (async () => {
      if (!isConsentCurrent(await readConsent().catch(() => null))) return;
      const { today, materials, diaries } = await recentMaterials(deviceTimeZone());
      const days = staleDays({ today, materials, diaries }).filter((d) => !attempted.has(d));
      let latest: string | null = null;
      for (const day of days) {
        if (cancelled) return;
        attempted.add(day);
        try {
          await generateDiary(day);
          latest = day;
        } catch {
          // 下次打开再试
        }
      }
      if (!cancelled && latest) setWritten(latest);
    })().catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!written) return;
    const timer = window.setTimeout(() => setWritten(null), NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [written]);

  if (!written) return null;
  return (
    <Link className="diary-ready-notice" href={`/memo/day/${written}`} onClick={() => setWritten(null)}>
      {shortDay(written)} 的手帐写好了，去看看 →
    </Link>
  );
}
