"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useMemo, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { ChevronLeft, FileAudio, MapPin } from "lucide-react";
import { AppNav } from "@/components/AppNav";
import { formatDuration } from "@/components/memo/labels";
import { db } from "@/lib/db";
import { describeMemoError } from "@/lib/memo/client/api";
import { fromLocalInputValue, inspectAudioFile, toLocalInputValue, type InspectedAudio } from "@/lib/memo/client/import";
import { reverseGeocode, samplePosition } from "@/lib/memo/client/location";
import { createSession, finalizeAudio, runPipeline, type PipelineProgress } from "@/lib/memo/client/orchestrator";
import type { PlaceRef } from "@/lib/memo/types";
import styles from "../memo.module.css";

export default function ImportPage() {
  return (
    <Suspense fallback={null}>
      <ImportInner />
    </Suspense>
  );
}

function ImportInner() {
  const params = useSearchParams();
  const router = useRouter();
  const backfill = params.get("kind") === "backfill";
  const [file, setFile] = useState<File | null>(null);
  const [info, setInfo] = useState<InspectedAudio | null>(null);
  const [startValue, setStartValue] = useState("");
  const [placeName, setPlaceName] = useState("");
  const [placeSource, setPlaceSource] = useState<PlaceRef["source"]>("manual");
  const [busy, setBusy] = useState<"" | "inspect" | "locate" | "process">("");
  const [error, setError] = useState("");
  const [progress, setProgress] = useState<PipelineProgress | null>(null);

  const startIso = startValue ? fromLocalInputValue(startValue) : null;
  // 默认给同一时间 ±2 小时内有坐标的遇见集藏品当地点候选（spec §4.10 import.ts）
  const nearby = useLiveQuery(async () => {
    if (!startIso) return [];
    const at = new Date(startIso).getTime();
    const items = await db.items.filter((i) => !i.isSeed && i.lat !== null && Math.abs(new Date(i.date).getTime() - at) <= 2 * 3600_000).limit(12).toArray();
    return [...new Set(items.map((i) => i.place).filter(Boolean))].slice(0, 6);
  }, [startIso], []);

  const timeHint = useMemo(() => {
    if (!info) return "";
    if (info.creationTime) return "来自文件里的录制时间。它通常就是开始录音的时间，但不保证，请核对。";
    if (info.lastModified) return "文件里读不到录制时间，先填了文件修改时间（可能不准），请改成实际开始录音的时间。";
    return "请填写开始录音的时间。";
  }, [info]);

  async function pick(selected: File | null) {
    setError("");
    setFile(selected);
    setInfo(null);
    if (!selected) return;
    setBusy("inspect");
    try {
      const inspected = await inspectAudioFile(selected);
      setInfo(inspected);
      setStartValue(toLocalInputValue(inspected.creationTime ?? inspected.lastModified ?? new Date().toISOString()));
    } catch (cause) {
      setError(describeMemoError(cause));
    } finally {
      setBusy("");
    }
  }

  async function useCurrentPosition() {
    setBusy("locate");
    const position = await samplePosition();
    const named = position ? await reverseGeocode(position) : null;
    if (named) {
      setPlaceName(named.place);
      setPlaceSource("gps");
    } else {
      setError("定位不可用，请手动填地点。");
    }
    setBusy("");
  }

  async function confirm() {
    if (!file || !info || !startIso) return;
    setError("");
    setBusy("process");
    try {
      const unchanged = info.creationTime && toLocalInputValue(info.creationTime) === startValue;
      const session = await createSession({
        kind: backfill ? "backfill" : "import",
        startedAt: startIso,
        durationSec: info.durationSec ?? 0,
        startedAtSource: unchanged ? "file_metadata" : "user",
        ...(placeName.trim() ? { place: { name: placeName.trim(), source: placeSource, confidence: "high" as const, locked: true } } : {}),
      });
      await finalizeAudio(session.id, file, info.mime);
      const final = await runPipeline(session.id, { onProgress: setProgress });
      const moments = await db.moments.where("sessionId").equals(session.id).toArray();
      const day = moments.find((m) => m.decision !== "drop")?.dayKey;
      router.push(final.status === "ready" && day ? `/memo/day/${day}` : `/memo/session/${session.id}`);
    } catch (cause) {
      setError(describeMemoError(cause));
      setBusy("");
    }
  }

  return (
    <main className="app-shell">
      <div className="phone-page">
        <div className={styles.top}>
          <Link className={styles.back} href="/memo">
            <ChevronLeft size={16} /> 遇见手记
          </Link>
        </div>
        <h1 className={styles.title}>{backfill ? "导入一段事后感想" : "导入录音"}</h1>
        <p className={styles.subtitle}>语音备忘录 → 分享 → 存储到「文件」，再在这里选择。支持 m4a、mp3、wav。</p>

        <section className={styles.card} style={{ marginTop: 16 }}>
          <label className={styles.label}>
            选择音频文件
            <input className={styles.input} type="file" accept="audio/*,.m4a" onChange={(e) => void pick(e.target.files?.[0] ?? null)} disabled={busy === "process"} />
          </label>
          {busy === "inspect" ? <p className={`${styles.small} ${styles.muted}`}>正在读取录制时间和时长…</p> : null}
          {file && info ? (
            <div className={styles.stack}>
              <div className={styles.row}>
                <FileAudio size={16} />
                <span className={styles.small}>
                  {file.name} · {(file.size / 1024 / 1024).toFixed(1)} MB · {info.durationSec ? formatDuration(info.durationSec) : "时长读不到，转写后补上"}
                </span>
              </div>
              <label className={styles.label}>
                开始录音的时间
                <input className={styles.input} type="datetime-local" value={startValue} onChange={(e) => setStartValue(e.target.value)} />
                <span className={`${styles.small} ${styles.muted}`} style={{ fontWeight: 500 }}>{timeHint}</span>
              </label>
              <label className={styles.label}>
                在哪里（可以不填）
                <input className={styles.input} value={placeName} placeholder="比如：伦敦 · 海德公园" onChange={(e) => { setPlaceName(e.target.value); setPlaceSource("manual"); }} />
              </label>
              <div className={styles.row}>
                {nearby.map((name) => (
                  <button key={name} type="button" className={styles.badge} onClick={() => { setPlaceName(name); setPlaceSource("photo"); }}>
                    {name}
                  </button>
                ))}
                <button type="button" className={styles.button} onClick={() => void useCurrentPosition()} disabled={busy === "locate"}>
                  <MapPin size={13} /> 用现在的位置
                </button>
              </div>
              {nearby.length ? <span className={`${styles.small} ${styles.muted}`}>上面是同一时间前后 2 小时你拍的照片的地点。</span> : null}
              <button type="button" className={`${styles.button} ${styles.buttonPrimary}`} onClick={() => void confirm()} disabled={!startIso || busy === "process"}>
                {busy === "process" ? progress?.message ?? "开始处理" : "确认，开始处理"}
              </button>
            </div>
          ) : null}
        </section>
        {error ? <div className={styles.warning} style={{ marginTop: 12 }}>{error}</div> : null}
        <p className={styles.privacy}>音频会上传到服务器转码，交给阿里云百炼语音识别；转写完成后服务器和手机里的音频都会删除。</p>
      </div>
      <AppNav />
    </main>
  );
}
