"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { grantConsent, isConsentCurrent, readConsent } from "@/lib/consent";
import styles from "./ConsentGate.module.css";

/**
 * 法务页面本身不能被同意弹层挡住 —— 用户得先读得到才能同意。
 * 反馈页同理：出了问题的人应该随时能告诉我们，不该先被要求同意什么。
 */
const ALWAYS_OPEN = ["/legal", "/feedback"];

export function ConsentGate() {
  const pathname = usePathname();
  const [status, setStatus] = useState<"loading" | "needed" | "granted">("loading");
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    let active = true;
    void readConsent()
      .then((stored) => {
        if (!active) return;
        setStatus(isConsentCurrent(stored) ? "granted" : "needed");
      })
      .catch(() => {
        if (active) setStatus("needed");
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (status !== "needed") return;
    if (ALWAYS_OPEN.some((prefix) => pathname.startsWith(prefix))) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [status, pathname]);

  if (status !== "needed") return null;
  if (ALWAYS_OPEN.some((prefix) => pathname.startsWith(prefix))) return null;

  async function accept() {
    try {
      await grantConsent();
    } catch {
      // 存不下也放行：不能因为浏览器存储不可用就把人挡在门外，
      // 代价只是下次打开会再问一次。
    }
    setStatus("granted");
  }

  return (
    <div className={styles.backdrop} role="dialog" aria-modal="true" aria-labelledby="consent-title">
      <div className={styles.sheet}>
        <p className="eyebrow">开始之前</p>
        <h2 id="consent-title">你的照片留在你自己手里</h2>

        <ul className={styles.points}>
          <li>
            <strong>照片和记录只存在这台设备的浏览器里。</strong>
            我们没有账号系统，服务端不保存你的任何照片或记录。
          </li>
          <li>
            识别时，照片会<strong>临时</strong>发送给模型服务商处理，处理完即丢弃。
          </li>
          <li>
            我们会读取照片里的<strong>拍摄时间和 GPS 坐标</strong>（如果有），
            用来自动填写时间和地点。这些信息同样只留在本机。
          </li>
          <li>
            AI 生成的内容<strong>可能不准确</strong>，未经核实，不要当作鉴定或安全依据。
          </li>
          <li>
            浏览器清理缓存会导致数据丢失。请在「我的」页开启持久化并定期导出备份。
          </li>
        </ul>

        <label className={styles.agree}>
          <input
            type="checkbox"
            checked={checked}
            onChange={(event) => setChecked(event.target.checked)}
          />
          <span>
            我已阅读并同意
            <Link href="/legal/terms">《用户协议》</Link>和
            <Link href="/legal/privacy">《隐私政策》</Link>
          </span>
        </label>

        <button className="primary-action" disabled={!checked} onClick={() => void accept()}>
          开始使用
        </button>
      </div>
    </div>
  );
}
