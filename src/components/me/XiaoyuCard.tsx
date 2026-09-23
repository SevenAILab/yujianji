"use client";

// 「我的」第一张卡：记忆 Agent 小遇。只显示能从本机记录确认的数字（反馈次数、学会的规则数），
// 不做百分比——"默契度"这类数现在算不可靠。
import Link from "next/link";
import { useLiveQuery } from "dexie-react-hooks";
import { ChevronRight, Sparkles, UserRound } from "lucide-react";
import { AGENT_AVATAR, AGENT_NAME } from "@/lib/agent-persona";
import { db } from "@/lib/db";
import rows from "./DeviceSection.module.css";
import styles from "./XiaoyuCard.module.css";

export function XiaoyuCard() {
  const enrolled = useLiveQuery(async () => (await db.memoVoiceprint.count()) > 0, [], false);
  const feedback = useLiveQuery(() => db.feedbackEvents.count(), [], 0);
  const taught = useLiveQuery(async () => {
    const latest = await db.profiles.orderBy("version").last();
    return latest ? latest.rules.filter((rule) => rule.origin !== "seed" && rule.active).length : 0;
  }, [], 0);

  return (
    <section className={rows.card} aria-label={AGENT_NAME}>
      <div className={styles.head}>
        <span className={styles.avatar} aria-hidden>
          {AGENT_AVATAR}
        </span>
        <div>
          <h2 className={styles.title}>{AGENT_NAME}</h2>
          <p className={styles.line}>替你听录音、挑出值得留的话、写成手帐，从你的删改里学你在乎什么。</p>
        </div>
      </div>
      <ul className={rows.rows}>
        <li>
          <Sparkles size={18} aria-hidden />
          <span className={rows.name}>
            {AGENT_NAME}眼中的你
            <small>{taught ? `已学会 ${taught} 条你的习惯 · 收到反馈 ${feedback} 次` : feedback ? `收到反馈 ${feedback} 次，还没形成新规则` : "还在按默认规则挑，你删改几段它就开始学"}</small>
          </span>
          <Link href="/memo/me" className={rows.action}>
            看看 <ChevronRight size={14} />
          </Link>
        </li>
        <li>
          <UserRound size={18} aria-hidden />
          <span className={rows.name}>
            声音注册
            <small>{enrolled ? `已注册，录音时${AGENT_NAME}认得你` : `花 8 秒，让${AGENT_NAME}分清哪句是你说的`}</small>
          </span>
          <Link href="/memo/enroll" className={rows.action}>
            {enrolled ? "重录" : "去注册"} <ChevronRight size={14} />
          </Link>
        </li>
      </ul>
    </section>
  );
}
