"use client";

import { Check, Copy } from "lucide-react";
import { useState } from "react";
import styles from "@/app/memo/memo.module.css";

/** Clipboard API；iOS 旧版或非安全上下文退回 execCommand。复制成功才回调（计入反馈事件）。 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 走下面的兜底
  }
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    area.setSelectionRange(0, text.length);
    const ok = document.execCommand("copy");
    document.body.removeChild(area);
    return ok;
  } catch {
    return false;
  }
}

export function CopyButton({ text, onCopied, label = "复制" }: { text: string; onCopied?: () => void; label?: string }) {
  const [state, setState] = useState<"idle" | "done" | "failed">("idle");
  return (
    <button
      type="button"
      className={styles.button}
      onClick={async () => {
        const ok = await copyText(text);
        setState(ok ? "done" : "failed");
        if (ok) onCopied?.();
        setTimeout(() => setState("idle"), 1600);
      }}
    >
      {state === "done" ? <Check size={14} /> : <Copy size={14} />}
      {state === "done" ? "已复制" : state === "failed" ? "复制失败" : label}
    </button>
  );
}
