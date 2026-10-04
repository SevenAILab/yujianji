"use client";

// 从飞书导入录音豆的录音（外部设备接入工单 v2 Gate 1）：先手动——列表、勾选、核对开录时间、再进现有管线。
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, Link2, Unlink } from "lucide-react";
import { AppNav } from "@/components/AppNav";
import { formatDuration } from "@/components/memo/labels";
import { LOCAL_ONLY } from "@/lib/app-mode";
import { describeMemoError, MemoApiError } from "@/lib/memo/client/api";
import {
  claimFeishuAuth,
  feishuAuthorizeUrl,
  forgetFeishuAuth,
  importedFeishuTokens,
  importFeishuMinute,
  listFeishuMinutes,
  loadFeishuAuth,
  previewFeishuMinute,
  type FeishuAuth,
  type FeishuMinuteItem,
  type FeishuPreview,
} from "@/lib/memo/client/feishu";
import { fromLocalInputValue, toLocalInputValue } from "@/lib/memo/client/import";
import type { PipelineProgress } from "@/lib/memo/client/orchestrator";
import { localClock } from "@/lib/memo/feishu-transcript";
import { dayKeyIn, deviceTimeZone } from "@/lib/memo/time";
import styles from "../memo.module.css";

const ERROR_TEXT: Record<string, string> = {
  FEISHU_NOT_CONFIGURED: "服务器还没配置飞书应用，暂时不能从飞书导入。",
  FEISHU_DENIED: "你在飞书里取消了授权。",
  FEISHU_STATE_MISMATCH: "授权校验没通过（可能是链接过期了），请重新授权。",
  FEISHU_AUTH_EXPIRED: "飞书授权过期了，请重新授权。",
  FEISHU_ERROR: "飞书授权失败，请重试。",
};

function todayKey(): string {
  return dayKeyIn(new Date().toISOString(), deviceTimeZone());
}

/** 选中的那天 00:00 到第三天 23:59（录音往往晚一两天才同步到飞书），不超过现在 */
function searchRange(dayKey: string): { startIso: string; endIso: string } {
  const start = new Date(`${dayKey}T00:00:00`);
  const end = new Date(start.getTime() + 3 * 86_400_000 - 1);
  return { startIso: start.toISOString(), endIso: new Date(Math.min(end.getTime(), Date.now())).toISOString() };
}

export default function FeishuImportPage() {
  return (
    <Suspense fallback={null}>
      <FeishuImportInner />
    </Suspense>
  );
}

function FeishuImportInner() {
  const params = useSearchParams();
  const router = useRouter();
  const [auth, setAuth] = useState<FeishuAuth | null | undefined>(undefined);
  const [day, setDay] = useState(todayKey);
  const [items, setItems] = useState<FeishuMinuteItem[] | null>(null);
  const [previews, setPreviews] = useState<Record<string, FeishuPreview | { error: string }>>({});
  const [imported, setImported] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<"" | "list" | "import">("");
  const [progress, setProgress] = useState<{ done: number; total: number; current?: PipelineProgress } | null>(null);
  const [results, setResults] = useState<{ token: string; title: string; ok: boolean; message: string; dayKey?: string; sessionId?: string }[]>([]);
  const [error, setError] = useState(() => ERROR_TEXT[params.get("error") ?? ""] ?? "");
  const claimed = useRef(false);

  useEffect(() => {
    if (claimed.current) return;
    claimed.current = true;
    void (async () => {
      if (params.get("connected") === "1") {
        try {
          setAuth(await claimFeishuAuth());
        } catch (cause) {
          setError(describeMemoError(cause));
          setAuth(await loadFeishuAuth());
        }
        router.replace("/memo/feishu");
        return;
      }
      setAuth(await loadFeishuAuth());
    })();
  }, [params, router]);

  const refreshList = useCallback(async () => {
    setBusy("list");
    setError("");
    setSelected(new Set());
    setPreviews({});
    try {
      const [list, done] = await Promise.all([listFeishuMinutes(searchRange(day)), importedFeishuTokens()]);
      setItems(list.items);
      setImported(done);
      // 逐条读开录时间（文字记录头部）。串行：飞书接口有频率限制
      for (const item of list.items) {
        try {
          const preview = await previewFeishuMinute(item.token);
          setPreviews((prev) => ({ ...prev, [item.token]: preview }));
        } catch (cause) {
          if (cause instanceof MemoApiError && cause.code.startsWith("FEISHU_AUTH")) throw cause;
          setPreviews((prev) => ({ ...prev, [item.token]: { error: describeMemoError(cause) } }));
        }
      }
    } catch (cause) {
      setError(describeMemoError(cause));
      if (cause instanceof MemoApiError && cause.code.startsWith("FEISHU_AUTH")) setAuth(null);
    } finally {
      setBusy("");
    }
  }, [day]);

  useEffect(() => {
    if (auth) void refreshList();
  }, [auth, refreshList]);

  function toggle(token: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(token)) next.delete(token);
      else next.add(token);
      return next;
    });
  }

  async function runImport() {
    const tokens = [...selected];
    setBusy("import");
    setError("");
    setResults([]);
    const out: typeof results = [];
    for (const [index, token] of tokens.entries()) {
      const title = items?.find((i) => i.token === token)?.title ?? token;
      setProgress({ done: index, total: tokens.length });
      try {
        const override = overrides[token] ? fromLocalInputValue(overrides[token]) : null;
        const session = await importFeishuMinute(token, {
          startedAtOverride: override,
          onProgress: (current) => setProgress({ done: index, total: tokens.length, current }),
        });
        const ok = session.status === "ready";
        out.push({ token, title, ok, message: ok ? "已整理好" : describeMemoError(new MemoApiError(session.error?.code ?? "CLIENT_ERROR", 0, session.error?.message ?? "处理没完成")), dayKey: dayKeyIn(session.startedAt, session.timeZone), sessionId: session.id });
      } catch (cause) {
        out.push({ token, title, ok: false, message: describeMemoError(cause) });
      }
      setResults([...out]);
    }
    setProgress(null);
    setBusy("");
    setSelected(new Set());
    setImported(await importedFeishuTokens());
  }

  const needsTime = [...selected].filter((token) => {
    const p = previews[token];
    return !overrides[token] && !(p && "recording" in p && p.recording);
  });

  if (LOCAL_ONLY) {
    return (
      <main className="app-shell">
        <div className="phone-page">
          <h1 className={styles.title}>从飞书导入</h1>
          <p className={styles.subtitle}>离线本地版不能连飞书，请用网页版。</p>
        </div>
        <AppNav />
      </main>
    );
  }

  return (
    <main className="app-shell">
      <div className="phone-page">
        <div className={styles.top}>
          <Link className={styles.back} href="/me">
            <ChevronLeft size={16} /> 我的
          </Link>
        </div>
        <h1 className={styles.title}>从飞书导入录音</h1>
        <p className={styles.subtitle}>安克录音豆（飞书版）的录音同步到飞书后，会生成妙记和文字记录。这里直接用飞书转好的文字，不再重新转写。</p>

        {auth === undefined ? null : !auth ? (
          <section className={styles.card} style={{ marginTop: 16 }}>
            <p className={styles.small}>先授权遇见集读取你飞书里的妙记。只申请读取权限：妙记列表、文字记录、录音音频。</p>
            <a className={`${styles.button} ${styles.buttonPrimary}`} href={feishuAuthorizeUrl()}>
              <Link2 size={14} /> 授权飞书
            </a>
          </section>
        ) : (
          <>
            <section className={styles.card} style={{ marginTop: 16 }}>
              <label className={styles.label}>
                哪一天的录音
                <input className={styles.input} type="date" value={day} max={todayKey()} onChange={(e) => setDay(e.target.value)} disabled={busy !== ""} />
              </label>
              <p className={`${styles.small} ${styles.muted}`}>会列出这一天起三天内同步到飞书的录音（录音常常晚一两天才同步）。开录时间以飞书文字记录为准。</p>
              <div className={styles.row}>
                <button type="button" className={styles.button} onClick={() => void refreshList()} disabled={busy !== ""}>
                  {busy === "list" ? "正在读取…" : "刷新列表"}
                </button>
                <button
                  type="button"
                  className={`${styles.button} ${styles.buttonGhost}`}
                  onClick={() => void forgetFeishuAuth().then(() => { setAuth(null); setItems(null); })}
                  disabled={busy !== ""}
                >
                  <Unlink size={13} /> 断开飞书
                </button>
              </div>
            </section>

            {items ? (
              <section className={styles.card} style={{ marginTop: 12 }}>
                {items.length === 0 ? <p className={`${styles.small} ${styles.muted}`}>这几天没有同步到飞书的录音。</p> : null}
                <div className={styles.stack}>
                  {items.map((item) => {
                    const preview = previews[item.token];
                    const ok = preview && "recording" in preview ? preview : null;
                    const failed = preview && "error" in preview ? preview.error : "";
                    const recordedDay = ok?.recording ? dayKeyIn(ok.recording.startedAt, deviceTimeZone()) : null;
                    const done = imported.has(item.token);
                    return (
                      <label key={item.token} className={styles.listItem} style={{ opacity: recordedDay && recordedDay !== day ? 0.6 : 1 }}>
                        <div className={styles.row}>
                          <input type="checkbox" checked={selected.has(item.token)} onChange={() => toggle(item.token)} disabled={done || busy !== "" || Boolean(failed)} />
                          <strong className={styles.small}>{item.title}</strong>
                          {done ? <span className={`${styles.badge} ${styles.badgeOk}`}>已导入</span> : null}
                        </div>
                        <span className={`${styles.small} ${styles.muted}`}>
                          {ok
                            ? `${ok.recording ? `录于 ${ok.recording.startedAt.slice(5, 10)} ${localClock(ok.recording.startedAt, ok.recording.tzOffsetMin)}–${localClock(ok.recording.endedAt, ok.recording.tzOffsetMin)}` : "读不到录音时间"} · ${ok.durationMs ? formatDuration(Math.round(ok.durationMs / 1000)) : "时长未知"} · ${ok.speakers} 位说话人`
                            : failed || "正在读取录音时间…"}
                        </span>
                        {selected.has(item.token) && ok && !ok.recording ? (
                          <input
                            className={styles.input}
                            type="datetime-local"
                            value={overrides[item.token] ?? ""}
                            onChange={(e) => setOverrides((prev) => ({ ...prev, [item.token]: e.target.value }))}
                            aria-label="开始录音的时间"
                          />
                        ) : null}
                        {selected.has(item.token) && ok?.recording ? (
                          <details>
                            <summary className={`${styles.small} ${styles.muted}`}>时间不对？改一下</summary>
                            <input
                              className={styles.input}
                              type="datetime-local"
                              value={overrides[item.token] ?? toLocalInputValue(ok.recording.startedAt)}
                              onChange={(e) => setOverrides((prev) => ({ ...prev, [item.token]: e.target.value }))}
                              aria-label="开始录音的时间"
                            />
                          </details>
                        ) : null}
                      </label>
                    );
                  })}
                </div>
                {selected.size ? (
                  <button
                    type="button"
                    className={`${styles.button} ${styles.buttonPrimary}`}
                    style={{ marginTop: 12 }}
                    onClick={() => void runImport()}
                    disabled={busy !== "" || needsTime.length > 0}
                  >
                    {busy === "import"
                      ? `${progress ? `第 ${progress.done + 1}/${progress.total} 段：` : ""}${progress?.current?.message ?? "处理中"}`
                      : needsTime.length
                        ? "先填开始录音的时间"
                        : `导入选中的 ${selected.size} 段`}
                  </button>
                ) : null}
              </section>
            ) : null}

            {results.length ? (
              <section className={styles.card} style={{ marginTop: 12 }}>
                <div className={styles.stack}>
                  {results.map((r) => (
                    <div key={r.token} className={styles.row}>
                      <span className={`${styles.badge} ${r.ok ? styles.badgeOk : styles.badgeWarn}`}>{r.ok ? "完成" : "没完成"}</span>
                      <span className={styles.small}>{r.title} · {r.message}</span>
                      {r.ok && r.dayKey ? <Link className={styles.small} href={`/memo/day/${r.dayKey}`}>看这天的手记</Link> : r.sessionId ? <Link className={styles.small} href={`/memo/session/${r.sessionId}`}>看过程</Link> : null}
                    </div>
                  ))}
                </div>
              </section>
            ) : null}
          </>
        )}
        {error ? <div className={styles.warning} style={{ marginTop: 12 }}>{error}</div> : null}
        <p className={styles.privacy}>授权令牌只存在这台手机上。导入时服务器向飞书取文字记录和音频，音频只用来判断哪句是你说的，算完立刻删除；别人说的话不会进手记。</p>
      </div>
      <AppNav />
    </main>
  );
}
