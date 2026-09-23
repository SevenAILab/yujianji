"use client";

// 「我的」里的可接入设备（工单 Gate 5.1）：只列支持的类型，没接入就只有名字和「接入」，
// 接入之后才显示详情。录音豆、眼镜还不能直连，「接入」= 一句说明 + 去首页导入。
import Link from "next/link";
import { useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { Camera, ChevronRight, Glasses, HeartPulse, Mic, Sparkles, UserRound } from "lucide-react";
import { db } from "@/lib/db";
import { useInsta360 } from "@/lib/insta360";
import styles from "./DeviceSection.module.css";

type Expandable = "bean" | "glasses" | null;

export function DeviceSection() {
  const insta360 = useInsta360();
  const [open, setOpen] = useState<Expandable>(null);
  const enrolled = useLiveQuery(async () => (await db.memoVoiceprint.count()) > 0, [], false);

  return (
    <>
      <section className={styles.card} aria-label="可接入设备">
        <p className="eyebrow">可接入设备</p>
        <h2>让别的设备帮你记</h2>
        <ul className={styles.rows}>
          <li>
            <Camera size={18} aria-hidden />
            <span className={styles.name}>
              360 全景相机
              {insta360 ? <small className={styles.connected}>已连接 · {insta360.name}</small> : null}
            </span>
            <Link href="/devices" className={styles.action}>
              {insta360 ? "管理" : "接入"}
            </Link>
          </li>
          <li>
            <Mic size={18} aria-hidden />
            <span className={styles.name}>录音豆</span>
            <button type="button" className={styles.action} onClick={() => setOpen(open === "bean" ? null : "bean")} aria-expanded={open === "bean"}>
              接入
            </button>
          </li>
          {open === "bean" ? (
            <li className={styles.note}>
              录完之后，在<Link href="/">首页点「导入」</Link>选这段录音就能加进来。设备直连还在做。
            </li>
          ) : null}
          <li>
            <Glasses size={18} aria-hidden />
            <span className={styles.name}>智能眼镜</span>
            <button type="button" className={styles.action} onClick={() => setOpen(open === "glasses" ? null : "glasses")} aria-expanded={open === "glasses"}>
              接入
            </button>
          </li>
          {open === "glasses" ? (
            <li className={styles.note}>
              眼镜拍的照片和录音，存到手机后在<Link href="/">首页点「导入」</Link>加进来。设备直连还在做。
            </li>
          ) : null}
          <li>
            <HeartPulse size={18} aria-hidden />
            <span className={styles.name}>蓝牙心率</span>
            <Link href="/devices" className={styles.action}>
              接入
            </Link>
          </li>
        </ul>
      </section>

      <section className={styles.card} aria-label="遇见手记">
        <p className="eyebrow">遇见手记</p>
        <ul className={styles.rows}>
          <li>
            <UserRound size={18} aria-hidden />
            <span className={styles.name}>
              声音注册
              <small>{enrolled ? "已注册，录音时它认得你" : "花 8 秒，让它分清哪句是你说的"}</small>
            </span>
            <Link href="/memo/enroll" className={styles.action}>
              {enrolled ? "重录" : "去注册"} <ChevronRight size={14} />
            </Link>
          </li>
          <li>
            <Sparkles size={18} aria-hidden />
            <span className={styles.name}>
              它学到了什么
              <small>你删过、改过的，它都记着</small>
            </span>
            <Link href="/memo/me" className={styles.action}>
              看看 <ChevronRight size={14} />
            </Link>
          </li>
        </ul>
      </section>
    </>
  );
}
