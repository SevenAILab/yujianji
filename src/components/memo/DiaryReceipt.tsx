import { AGENT_AVATAR, AGENT_NAME } from "@/lib/agent-persona";
import type { DiaryReceipt as Receipt } from "@/lib/memo/receipt";
import { receiptSentence } from "@/lib/memo/receipt";
import { clockIn, dayKeyIn, shortDay } from "@/lib/memo/time";
import styles from "./DiaryReceipt.module.css";

/** 手帐顶上的一行：小遇这天做了什么。数字全部来自本机记录，示例天标「示例」。 */
export function DiaryReceipt({ receipt, dayKey, timeZone, demo }: { receipt: Receipt; dayKey: string; timeZone: string; demo: boolean }) {
  const when = receipt.generatedAt
    ? dayKeyIn(receipt.generatedAt, timeZone) === dayKey
      ? `整理于 ${clockIn(receipt.generatedAt, timeZone)}`
      : `${shortDay(dayKeyIn(receipt.generatedAt, timeZone))} ${clockIn(receipt.generatedAt, timeZone)} 整理`
    : "";
  const taught = receipt.profileVersion > 1 ? `用的是你教过的偏好（第 ${receipt.profileVersion} 版）` : "";
  return (
    <section className={styles.receipt} aria-label={`${AGENT_NAME}的整理回执`}>
      <div className={styles.head}>
        <span className={styles.avatar} aria-hidden>
          {AGENT_AVATAR}
        </span>
        <strong>{AGENT_NAME}的整理回执</strong>
        {demo ? <span className={styles.tag}>示例</span> : null}
      </div>
      <p className={styles.sentence}>{receiptSentence(receipt, AGENT_NAME)}</p>
      {when || taught ? <small className={styles.meta}>{[when, taught].filter(Boolean).join(" · ")}</small> : null}
    </section>
  );
}
