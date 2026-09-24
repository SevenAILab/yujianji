"use client";

import { Camera, FolderInput, Mic, Sparkles } from "lucide-react";
import Link from "next/link";
import { AppNav } from "@/components/AppNav";
import { MemoryGlobe } from "@/components/MemoryGlobe";
import styles from "./style-lab.module.css";

/**
 * 风格探索页：沿用首页的信息架构，只替换视觉语言。
 * 这里不接入真实记录，避免影响现有首页的数据和流程。
 */
export default function StyleLabPage() {
  return (
    <main className={styles.page}>
      <div className={styles.phonePage}>
        <header className={styles.heroHeader}>
          <div className={styles.heroCopy}>
            <p className={styles.wordmark}>遇见集<sup>®</sup></p>
            <p className={styles.subtitle}>A COLLECTION OF ENCOUNTERS</p>
            <p className={styles.tagline}>每一次新的遇见，都是一个人精神图景的扩张</p>
          </div>
          <Link className={styles.universeEntry} href="/universe" aria-label="进入精神图景">
            <Sparkles size={18} strokeWidth={1.9} />
            <span>进入图景</span>
          </Link>
        </header>

        <div className={styles.globeStage}>
          <MemoryGlobe pins={[]} />
        </div>

        <section className={styles.dashboard} aria-label="开始一次遇见">
          <div className={styles.captureActions}>
            <label htmlFor="style-lab-camera" className={styles.captureAction}>
              <Camera size={21} strokeWidth={1.7} />
              <span>拍摄</span>
            </label>
            <button type="button" className={styles.captureAction}>
              <Mic size={21} strokeWidth={1.7} />
              <span>录音</span>
            </button>
            <label htmlFor="style-lab-import" className={styles.captureAction}>
              <FolderInput size={21} strokeWidth={1.7} />
              <span>导入</span>
            </label>
          </div>
          <Link className={styles.textEntry} href="/encounter?mode=text">没有照片？写几句也行</Link>
          <div className={styles.captureInputs} aria-hidden="true">
            <input id="style-lab-camera" type="file" accept="image/*,video/*" />
            <input id="style-lab-import" type="file" accept="image/*,video/*,audio/*" />
          </div>

          <div className={styles.stats} aria-label="遇见统计">
            <div><strong>5</strong><span>已遇见</span></div>
            <div><strong>4</strong><span>第一次</span></div>
            <div><strong>1</strong><span>国家</span></div>
            <div><strong>5</strong><span>地点</span></div>
          </div>
          <div className={styles.insight}><span>2026年9月，南山那张贴纸还在原处。</span></div>
        </section>
      </div>

      <div className={styles.navShell}>
        <AppNav />
      </div>
    </main>
  );
}
