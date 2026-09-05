"use client";

import { ArrowLeft, CircleAlert, MapPin } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { CATEGORY_LABELS } from "@/lib/types";
import { decodeSharePayload, type SharePayload } from "@/lib/share";
import { formatDate } from "@/lib/format";

export default function SharePage() {
  const [payload, setPayload] = useState<SharePayload | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    const encoded = window.location.hash.slice(1);
    const decoded = decodeSharePayload(encoded);
    if (!decoded) {
      setError("分享链接无效或内容已过期。");
      return;
    }
    setPayload(decoded);
  }, []);

  return (
    <main className="app-shell">
      <div className="phone-page">
        <header className="page-header">
          <Link className="icon-action" href="/" aria-label="返回遇见集">
            <ArrowLeft size={18} />
          </Link>
          <div className="brand-lockup">
            <h1>遇见集</h1>
            <span>YU JIAN JI</span>
          </div>
          <MapPin size={19} color="var(--teal)" />
        </header>

        {error ? (
          <div className="status-note warning" style={{ marginTop: 28 }}>
            <CircleAlert size={15} />
            <span>{error}</span>
          </div>
        ) : null}

        {payload ? (
          <div className="content-stack">
            {payload.photo ? (
              <div className="hero-photo">
                <img src={payload.photo} alt={payload.name} />
              </div>
            ) : null}

            <div className="detail-title">
              <div>
                <h1>{payload.name}</h1>
                <div className="detail-meta">
                  <span><MapPin size={13} /> {payload.place}</span>
                  <span>{formatDate(payload.date)}</span>
                  <span>{CATEGORY_LABELS[payload.category]}</span>
                </div>
              </div>
              <span className="badge">来自遇见集</span>
            </div>

            {payload.ai ? (
              <section className={`verdict-card ${payload.ai.verdict === "reunion" ? "reunion" : ""}`}>
                <p className="eyebrow">{payload.ai.verdict === "reunion" ? "这不是第一次" : "一件新的遇见"}</p>
                <h2>{payload.ai.verdict === "reunion" ? "重逢" : "初见"}</h2>
                <p>{payload.ai.memorySentence}</p>
              </section>
            ) : null}

            {payload.ai ? (
              <section className="content-card surface museum-section">
                <p className="eyebrow">AI 博物志</p>
                <div className="museum-section">
                  <h2>它是什么</h2>
                  <p>{payload.ai.cognition}</p>
                </div>
                <div className="museum-section">
                  <h2>有趣在哪</h2>
                  <p>{payload.ai.fun}</p>
                </div>
                <div className="museum-section">
                  <h2>你有多幸运</h2>
                  <p>{payload.ai.luckText}</p>
                  <div className="basis">依据：{payload.ai.luckBasis}</div>
                </div>
              </section>
            ) : null}

            <section className="content-card surface">
              <p className="eyebrow">我的记录</p>
              <p className="museum-section">{payload.heard || payload.userNote || "那一刻，他还没有留下话。"}</p>
              {payload.heard ? <div className="basis">来自视频中他说的话</div> : null}
            </section>

            {payload.ai?.question ? (
              <section className="content-card surface">
                <p className="eyebrow">它问他</p>
                <div className="question-box">
                  <strong>{payload.ai.question}</strong>
                  <p>把当时没说完的话，留到见面之后再说。</p>
                </div>
              </section>
            ) : null}

            <div className="action-row">
              <Link className="primary-action" href="/">打开遇见集</Link>
            </div>
          </div>
        ) : null}
      </div>
    </main>
  );
}
