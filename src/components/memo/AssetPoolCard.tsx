"use client";

// 手帐页的素材池入口（外部设备接入工单 v2 Gate 2）：把这天的照片放进来，只按拍摄时间进池、不识别；
// 写手帐时和"你说过的话"按时间对上的那张才会被识别、配上。
import { useLiveQuery } from "dexie-react-hooks";
import { useState } from "react";
import { ImagePlus } from "lucide-react";
import { assetsForDay, confirmHintTimes, importAssets } from "@/lib/memo/client/assets";
import styles from "@/app/memo/memo.module.css";

export function AssetPoolCard({ dayKey, hasDiary }: { dayKey: string; hasDiary: boolean }) {
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const pool = useLiveQuery(() => assetsForDay(dayKey).catch(() => ({ timed: [], untimed: [] })), [dayKey, busy]);

  async function onFiles(files: FileList | null) {
    const list = [...(files ?? [])];
    if (!list.length) return;
    setMessage("");
    setBusy("正在读取照片…");
    try {
      const s = await importAssets(list, (done, total) => setBusy(`正在读取照片 ${Math.min(done + 1, total)}/${total}…`));
      setMessage(
        `放进来 ${s.added} 张${s.duplicates ? `，${s.duplicates} 张之前放过` : ""}${s.missingTime ? `，${s.missingTime} 张读不到拍摄时间` : ""}${s.failed ? `，${s.failed} 张读不了` : ""}。${s.added ? (hasDiary ? "点「重新生成」配上照片。" : "生成手帐时会配上。") : ""}`,
      );
    } finally {
      setBusy("");
    }
  }

  async function useFileTimes() {
    const ids = (pool?.untimed ?? []).map((a) => a.id);
    const changed = await confirmHintTimes(ids);
    setMessage(`已按文件时间算 ${changed} 张${hasDiary ? "，点「重新生成」生效" : ""}。`);
  }

  return (
    <section className={styles.card} style={{ marginTop: 12 }} aria-label="这天的照片">
      <div className={styles.between}>
        <strong className={styles.small}>这天的照片 · {pool?.timed.length ?? 0} 张</strong>
        <label className={styles.button} aria-disabled={busy !== ""}>
          <ImagePlus size={13} /> {busy || "放进来"}
          <input type="file" accept="image/*" multiple hidden disabled={busy !== ""} onChange={(e) => { void onFiles(e.target.files); e.currentTarget.value = ""; }} />
        </label>
      </div>
      <span className={`${styles.small} ${styles.muted}`}>多选这天拍的照片。只按拍摄时间放进来，不逐张识别；和你说的话时间对得上的那张才会被识别、配进手帐。</span>
      {pool?.untimed.length ? (
        <div className={styles.row}>
          <span className={`${styles.small} ${styles.muted}`}>{pool.untimed.length} 张读不到拍摄时间，不参与自动配图。</span>
          <button type="button" className={styles.button} onClick={() => void useFileTimes()} disabled={busy !== ""}>
            按文件时间算
          </button>
        </div>
      ) : null}
      {message ? <span className={styles.small}>{message}</span> : null}
    </section>
  );
}
