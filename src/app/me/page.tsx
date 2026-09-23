"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import {
  AlertTriangle,
  Check,
  Download,
  HardDrive,
  MessageSquare,
  ShieldCheck,
  Sparkles,
  Trash2,
  Upload,
} from "lucide-react";
import { AppNav } from "@/components/AppNav";
import { DeviceSection } from "@/components/me/DeviceSection";
import { useRecorder } from "@/components/memo/RecorderProvider";
import { db, hasDemoData, loadDemoData, removeDemoData } from "@/lib/db";
import { downloadBackup, importBackup, wipeLocalData } from "@/lib/backup";
import {
  formatBytes,
  readLastExportAt,
  readStorageHealth,
  requestPersistence,
  shouldSuggestBackup,
  type StorageHealth,
} from "@/lib/storage-health";
import { APP_VERSION } from "@/lib/version";
import { canDownloadFiles, detectBrowser, openInBrowserHint, type BrowserKind } from "@/lib/browser-env";
import styles from "./me.module.css";

type Busy = "none" | "export" | "import" | "wipe" | "demo";

export default function MePage() {
  const recorder = useRecorder();
  const items = useLiveQuery(() => db.items.toArray(), [], []);
  const [health, setHealth] = useState<StorageHealth | null>(null);
  const [lastExportAt, setLastExportAt] = useState<string | null>(null);
  const [busy, setBusy] = useState<Busy>("none");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [confirmingWipe, setConfirmingWipe] = useState(false);
  const [demoLoaded, setDemoLoaded] = useState<boolean | null>(null);
  const [browserKind, setBrowserKind] = useState<BrowserKind>("standard");
  const importRef = useRef<HTMLInputElement>(null);

  const refreshHealth = useCallback(async () => {
    const [next, exportedAt] = await Promise.all([readStorageHealth(), readLastExportAt()]);
    setHealth(next);
    setLastExportAt(exportedAt);
  }, []);

  useEffect(() => {
    void refreshHealth();
    void hasDemoData().then(setDemoLoaded).catch(() => setDemoLoaded(false));
    setBrowserKind(detectBrowser());
  }, [refreshHealth]);

  const downloadable = canDownloadFiles(browserKind);

  const mine = useMemo(() => items.filter((item) => !item.isSeed), [items]);
  const stats = useMemo(() => {
    // 与首页口径一致：没补地点的记录国家是 UNK，不能算成「1 个国家/地区」。
    const countries = new Set(
      mine
        .map((item) => item.country)
        .filter((country) => country && country !== "UNK" && country !== "OTHER"),
    );
    return {
      total: mine.length,
      firsts: mine.filter((item) => item.ai?.verdict === "first").length,
      countries: countries.size,
    };
  }, [mine]);

  const backupOverdue = shouldSuggestBackup(stats.total, lastExportAt);
  const storageTight = health?.ratio !== null && health?.ratio !== undefined && health.ratio > 0.8;

  async function handlePersist() {
    const state = await requestPersistence();
    await refreshHealth();
    setNotice(
      state === "persisted"
        ? "已开启持久化存储，系统不会再自动清理这里的数据。"
        : state === "unsupported"
          ? "这个浏览器没有提供持久化存储开关。把遇见集加到主屏幕通常能提高数据存活率。"
          : "浏览器这次没有授予。把遇见集加到主屏幕后再试一次通常就能通过。",
    );
  }

  async function handleExport() {
    setBusy("export");
    setError("");
    setNotice("");
    try {
      const count = await downloadBackup();
      await refreshHealth();
      setNotice(`已导出 ${count} 条记录，照片都在这个文件里。把它存到网盘或发给自己。`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "导出失败，请重试。");
    } finally {
      setBusy("none");
    }
  }

  async function handleImport(file: File) {
    setBusy("import");
    setError("");
    setNotice("");
    try {
      const summary = await importBackup(file);
      await refreshHealth();
      setNotice(
        `导入完成：新增 ${summary.added} 条，更新 ${summary.updated} 条，已有且更新的跳过 ${summary.skipped} 条。` +
          (summary.memo ? `另外恢复了 ${summary.memo} 条遇见手记记录（逐字稿按 7 天清理的约定不在备份里）。` : ""),
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "导入失败，请确认文件正确。");
    } finally {
      setBusy("none");
      if (importRef.current) importRef.current.value = "";
    }
  }

  async function toggleDemo() {
    setBusy("demo");
    setError("");
    setNotice("");
    try {
      if (demoLoaded) {
        const removed = await removeDemoData();
        setDemoLoaded(false);
        setNotice(`已移除 ${removed} 条示例。你自己的记录没有受影响。`);
      } else {
        const added = await loadDemoData();
        setDemoLoaded(true);
        setNotice(`已载入 ${added} 条示例照片、模拟转写和手帐。模拟内容不含真实录音，也不会进入备份。`);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "操作失败，请重试。");
    } finally {
      setBusy("none");
    }
  }

  async function handleWipe() {
    setBusy("wipe");
    setError("");
    setNotice("");
    try {
      await recorder.discardAll();
      await wipeLocalData();
      await refreshHealth();
      setConfirmingWipe(false);
      setNotice("已删除本机的全部记录。");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "删除失败，请重试。");
    } finally {
      setBusy("none");
    }
  }

  return (
    <main className="app-shell">
      <div className="phone-page">
        <header className="page-header">
          <h1 className="page-title">我的</h1>
        </header>

        <section className={styles.stats}>
          <div>
            <strong>{stats.total}</strong>
            <span>条遇见</span>
          </div>
          <div>
            <strong>{stats.firsts}</strong>
            <span>次初见</span>
          </div>
          <div>
            <strong>{stats.countries}</strong>
            <span>个国家/地区</span>
          </div>
        </section>

        {backupOverdue ? (
          <div className={styles.suggest}>
            <AlertTriangle size={17} />
            <p>
              你已经攒下 {stats.total} 条记录，而且有一阵子没备份了。
              <strong>照片只存在这台设备上</strong>，导出一份放好会踏实很多。
            </p>
          </div>
        ) : null}

        <DeviceSection />

        <section className={styles.card}>
          <p className="eyebrow">本机存储</p>
          <h2>数据都在这台设备里</h2>
          <dl className={styles.rows}>
            <div>
              <dt>持久化</dt>
              <dd>
                {health === null
                  ? "读取中…"
                  : health.persist === "persisted"
                    ? "已开启"
                    : health.persist === "unsupported"
                      ? "此浏览器不支持"
                      : "未开启"}
              </dd>
            </div>
            <div>
              <dt>已用空间</dt>
              <dd>
                {health === null
                  ? "读取中…"
                  : health.usageBytes === null
                    ? "此浏览器不提供"
                    : `${formatBytes(health.usageBytes)}${
                        health.quotaBytes ? ` / ${formatBytes(health.quotaBytes)}` : ""
                      }`}
              </dd>
            </div>
            <div>
              <dt>上次导出</dt>
              <dd>{lastExportAt ? lastExportAt.slice(0, 10) : "还没导出过"}</dd>
            </div>
          </dl>

          {storageTight ? (
            <div className="error-box">
              存储空间快用完了。浏览器在空间不足时会拒绝写入新记录，
              请先导出备份，再删掉一些不需要的遇见。
            </div>
          ) : null}

          {health?.persist !== "persisted" ? (
            <>
              {browserKind !== "standard" ? (
                <p className={styles.hint}>
                  在{browserKind === "wechat" ? "微信" : "应用内置浏览器"}里通常拿不到持久化存储。
                  想让记录留得更久，{openInBrowserHint(browserKind)}，再把它添加到主屏幕。
                </p>
              ) : null}
              <button className="secondary-action" onClick={() => void handlePersist()}>
                <HardDrive size={17} />
                开启持久化存储
              </button>
            </>
          ) : null}
        </section>

        <section className={styles.card}>
          <p className="eyebrow">备份</p>
          <h2>导出与导入</h2>
          <p className={styles.hint}>
            遇见集<strong>从不上传你的照片</strong>。所以换设备时，这个文件是把照片带走的唯一方式——
            它包含全部记录和原图。
          </p>
          {!downloadable ? (
            <div className={styles.suggest}>
              <AlertTriangle size={17} />
              <p>
                {browserKind === "wechat" ? "微信" : "这个应用内置的浏览器"}
                会拦截文件下载，导出在这里点了不会有反应。
                <strong>{openInBrowserHint(browserKind)}</strong>，再回到这一页导出。
              </p>
            </div>
          ) : null}
          <div className={styles.actions}>
            <button
              className="primary-action"
              onClick={() => void handleExport()}
              disabled={busy !== "none" || stats.total === 0 || !downloadable}
            >
              <Download size={17} />
              {busy === "export" ? "正在打包…" : "导出备份"}
            </button>
            <button
              className="secondary-action"
              onClick={() => importRef.current?.click()}
              disabled={busy !== "none"}
            >
              <Upload size={17} />
              {busy === "import" ? "正在导入…" : "导入备份"}
            </button>
          </div>
          <input
            ref={importRef}
            className="file-input"
            type="file"
            accept="application/json,.json"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void handleImport(file);
            }}
          />
        </section>

        <section className={styles.card}>
          <p className="eyebrow">示例内容</p>
          <h2>演示展厅</h2>
          <p className={styles.hint}>
            25 张示例照片、25 段明确标记的模拟转写和对应手帐，可展示记忆宇宙。模拟内容不含真实录音，不属于你的记录，也不会进入备份。
          </p>
          <button
            className="secondary-action"
            onClick={() => void toggleDemo()}
            disabled={busy !== "none" || demoLoaded === null}
          >
            <Sparkles size={17} />
            {busy === "demo"
              ? "处理中…"
              : demoLoaded === null
                ? "读取中…"
                : demoLoaded
                  ? "移除示例内容"
                  : "载入示例内容"}
          </button>
        </section>

        {notice ? (
          <div className={styles.notice}>
            <Check size={16} />
            <span>{notice}</span>
          </div>
        ) : null}
        {error ? <div className="error-box">{error}</div> : null}

        <section className={styles.card}>
          <p className="eyebrow">关于</p>
          <nav className={styles.links}>
            <Link href="/legal/privacy">
              <ShieldCheck size={16} />
              隐私政策
            </Link>
            <Link href="/legal/terms">
              <ShieldCheck size={16} />
              用户协议
            </Link>
            <Link href="/feedback">
              <MessageSquare size={16} />
              反馈与举报
            </Link>
          </nav>
          <p className={styles.version}>版本 {APP_VERSION}</p>
        </section>

        <section className={`${styles.card} ${styles.danger}`}>
          <p className="eyebrow">危险操作</p>
          <h2>删除本机全部数据</h2>
          <p className={styles.hint}>
            会清空这台设备上的所有遇见、旅程和照片，无法撤销。
            服务端本来就没有你的照片，删除后我们这边也不会留下任何记录副本。
          </p>
          {confirmingWipe ? (
            <div className={styles.actions}>
              <button
                className={styles.dangerButton}
                onClick={() => void handleWipe()}
                disabled={busy !== "none"}
              >
                <Trash2 size={17} />
                {busy === "wipe" ? "正在删除…" : "确认删除，我已导出备份"}
              </button>
              <button className="secondary-action" onClick={() => setConfirmingWipe(false)}>
                取消
              </button>
            </div>
          ) : (
            <button
              className="secondary-action"
              onClick={() => setConfirmingWipe(true)}
              disabled={busy !== "none"}
            >
              <Trash2 size={17} />
              删除全部数据
            </button>
          )}
        </section>
      </div>
      <AppNav />
    </main>
  );
}
