"use client";

import Link from "next/link";
import { useState } from "react";
import { ArrowLeft, Check, Send } from "lucide-react";
import { apiFetch } from "@/lib/api-client";
import styles from "./feedback.module.css";

type Kind = "idea" | "bug" | "report";

const KINDS: Array<{ value: Kind; label: string; hint: string }> = [
  { value: "idea", label: "想法", hint: "希望它变成什么样" },
  { value: "bug", label: "出错了", hint: "哪一步没走通" },
  { value: "report", label: "举报", hint: "AI 说了不该说的，或内容不适当" },
];

export default function FeedbackPage() {
  const [kind, setKind] = useState<Kind>("idea");
  const [message, setMessage] = useState("");
  const [subject, setSubject] = useState("");
  const [contact, setContact] = useState("");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");

  async function submit() {
    if (message.trim().length < 4) {
      setError("再多写几个字，不然我看不出发生了什么。");
      return;
    }
    setSending(true);
    setError("");
    try {
      const response = await apiFetch("/api/feedback", {
        kind,
        message: message.trim(),
        subject: subject.trim() || undefined,
        contact: contact.trim() || undefined,
        path: typeof window === "undefined" ? undefined : window.location.pathname,
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(payload?.error ?? "提交失败，请重试。");
      }
      setSent(true);
      setMessage("");
      setSubject("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "提交失败，请重试。");
    } finally {
      setSending(false);
    }
  }

  return (
    <main className="app-shell">
      <div className={styles.page}>
        <Link className={styles.back} href="/me">
          <ArrowLeft size={15} />
          返回
        </Link>

        <h1 className="page-title">反馈与举报</h1>
        <p className={styles.lead}>
          这是测试版，你说的每一句我都会看到。内容会记录在服务端日志里，
          <strong>不会附带你的照片</strong>。
        </p>

        {sent ? (
          <div className={styles.done}>
            <Check size={18} />
            <div>
              <strong>收到了，谢谢。</strong>
              <p>如果留了联系方式，需要追问时我会找你。</p>
            </div>
          </div>
        ) : null}

        <div className={styles.kinds}>
          {KINDS.map((entry) => (
            <button
              key={entry.value}
              className={kind === entry.value ? styles.kindActive : styles.kind}
              onClick={() => {
                setKind(entry.value);
                setSent(false);
              }}
            >
              <strong>{entry.label}</strong>
              <span>{entry.hint}</span>
            </button>
          ))}
        </div>

        {kind === "report" ? (
          <label className={styles.field}>
            <span>被举报的内容是哪一条？（可选）</span>
            <input
              value={subject}
              maxLength={120}
              placeholder="比如：莫干山的粉色叶子"
              onChange={(event) => setSubject(event.target.value)}
            />
          </label>
        ) : null}

        <label className={styles.field}>
          <span>{kind === "report" ? "问题出在哪里" : "说说看"}</span>
          <textarea
            value={message}
            maxLength={2000}
            rows={7}
            placeholder={
              kind === "bug"
                ? "你做了什么、期待发生什么、实际发生了什么"
                : kind === "report"
                  ? "描述一下不合适的地方"
                  : "任何想法都可以"
            }
            onChange={(event) => {
              setMessage(event.target.value);
              setSent(false);
            }}
          />
        </label>

        <label className={styles.field}>
          <span>联系方式（可选）</span>
          <input
            value={contact}
            maxLength={120}
            placeholder="邮箱或微信，方便追问"
            onChange={(event) => setContact(event.target.value)}
          />
        </label>

        {error ? <div className="error-box">{error}</div> : null}

        <button className="primary-action" onClick={() => void submit()} disabled={sending}>
          <Send size={17} />
          {sending ? "正在发送…" : "发送"}
        </button>
      </div>
    </main>
  );
}
