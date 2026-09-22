"use client";

// 声纹注册：录一小段"我"的声音，之后每次录音都拼在识别任务最前面，用来认出哪句是我说的。
// 引导语是团队定的：不要"请朗读以下文字"那种死板写法。
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { ChevronLeft, Mic, RotateCcw, Square } from "lucide-react";
import { AppNav } from "@/components/AppNav";
import { db } from "@/lib/db";
import { pickMimeType, recordingSupported } from "@/lib/memo/client/recorder";
import styles from "../memo.module.css";

/** 8 秒足够 fun-asr 聚出一个稳定的说话人，再长用户就不耐烦了 */
const TARGET_MS = 8_000;

export default function EnrollPage() {
  const saved = useLiveQuery(() => db.memoVoiceprint.get("me"), [], undefined);
  const [state, setState] = useState<"idle" | "recording" | "saving">("idle");
  const [leftMs, setLeftMs] = useState(TARGET_MS);
  const [error, setError] = useState("");
  const [justSaved, setJustSaved] = useState(false);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      try {
        recorderRef.current?.stop();
      } catch {
        /* 卸载时停不掉就算了 */
      }
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  async function start() {
    setError("");
    setJustSaved(false);
    const support = recordingSupported();
    if (!support.ok) {
      setError(support.reason ?? "这个浏览器录不了音");
      return;
    }
    try {
      // 和正式录音用同一组参数：关掉自动增益和降噪，保留真实音色
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
      });
      streamRef.current = stream;
      const mimeType = pickMimeType();
      const recorder = new MediaRecorder(stream, { ...(mimeType ? { mimeType } : {}), audioBitsPerSecond: 64_000 });
      recorderRef.current = recorder;
      const parts: Blob[] = [];
      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) parts.push(e.data);
      };
      recorder.onstop = async () => {
        streamRef.current?.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
        const blob = new Blob(parts, { type: recorder.mimeType || mimeType || "audio/mp4" });
        if (blob.size === 0) {
          setError("没录到声音，再试一次。");
          setState("idle");
          return;
        }
        setState("saving");
        try {
          await db.memoVoiceprint.put({
            id: "me",
            blob,
            mime: recorder.mimeType || mimeType || "audio/mp4",
            durationMs: TARGET_MS,
            createdAt: new Date().toISOString(),
          });
          setJustSaved(true);
        } catch {
          setError("存不下来，可能是浏览器存储满了。");
        }
        setState("idle");
        setLeftMs(TARGET_MS);
      };

      recorder.start();
      setState("recording");
      const startedAt = Date.now();
      setLeftMs(TARGET_MS);
      timerRef.current = setInterval(() => {
        const left = TARGET_MS - (Date.now() - startedAt);
        setLeftMs(Math.max(0, left));
        if (left <= 0) {
          if (timerRef.current) clearInterval(timerRef.current);
          try {
            recorder.stop();
          } catch {
            setState("idle");
          }
        }
      }, 100);
    } catch (cause) {
      const name = (cause as { name?: string })?.name;
      setError(name === "NotAllowedError" ? "麦克风权限被拒了，去浏览器设置里打开。" : "拿不到麦克风，检查是不是被别的 App 占着。");
      setState("idle");
    }
  }

  function stopEarly() {
    if (timerRef.current) clearInterval(timerRef.current);
    try {
      recorderRef.current?.stop();
    } catch {
      setState("idle");
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

        <h1 className={styles.title}>让我认识你的声音</h1>
        <p className={styles.subtitle}>
          录音里常常不止你一个人说话。认过你的声音之后，我才知道哪几句是你说的，只把你的话留进手记。
        </p>

        <section className={styles.card} style={{ marginTop: 20 }}>
          <p className={styles.enrollPrompt}>按下按钮，随便说点什么，让我认识一下</p>
          <p className={`${styles.small} ${styles.muted}`}>说什么都行——今天去了哪、刚吃了什么。大概 8 秒，到时间会自动停。</p>

          {state === "recording" ? (
            <>
              <p className={styles.enrollCountdown}>{Math.ceil(leftMs / 1000)}</p>
              <button type="button" className={`${styles.button} ${styles.buttonPrimary}`} onClick={stopEarly}>
                <Square size={13} /> 说完了
              </button>
            </>
          ) : (
            <button
              type="button"
              className={`${styles.button} ${styles.buttonPrimary}`}
              onClick={() => void start()}
              disabled={state === "saving"}
            >
              {saved ? <RotateCcw size={13} /> : <Mic size={13} />}
              {state === "saving" ? "保存中…" : saved ? "重新录一次" : "开始"}
            </button>
          )}

          {justSaved ? <p className={styles.enrollOk}>认识你了。以后录音会自动认出哪几句是你说的。</p> : null}
          {!justSaved && saved ? (
            <p className={`${styles.small} ${styles.muted}`}>
              已经认过你的声音（{new Date(saved.createdAt).toLocaleDateString("zh-CN")}）。换了环境觉得认不准，可以重录。
            </p>
          ) : null}
          {error ? <div className={styles.warning} style={{ marginTop: 10 }}>{error}</div> : null}
        </section>

        <p className={styles.privacy}>
          这段声音只存在这台手机上。每次录音处理时会临时送到服务器，和录音一起交给语音识别用来认人，处理完立即删除。
          {saved ? " 不想留了可以直接删。" : ""}
        </p>
        {saved ? (
          <button
            type="button"
            className={`${styles.button} ${styles.buttonDanger}`}
            onClick={() => void db.memoVoiceprint.delete("me").then(() => setJustSaved(false))}
          >
            删掉我的声音
          </button>
        ) : null}
      </div>
      <AppNav />
    </main>
  );
}
