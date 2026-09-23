"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";
import { ChevronLeft, Globe2 } from "lucide-react";
import styles from "./universe.module.css";

export default function UniversePage() {
  const router = useRouter();
  const universeRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    function receiveUniverseEvent(event: MessageEvent) {
      if (event.origin !== window.location.origin || event.source !== universeRef.current?.contentWindow) return;
      if (event.data?.type === "memory-universe:enter-globe") router.push("/");
    }
    window.addEventListener("message", receiveUniverseEvent);
    return () => window.removeEventListener("message", receiveUniverseEvent);
  }, [router]);

  return (
    <main className={styles.shell}>
      <header className={styles.header}>
        <span className={styles.title}>记忆图景</span>
        <Link href="/" className={styles.back} aria-label="回到地球"><ChevronLeft size={18} /><Globe2 size={22} strokeWidth={1.8} /><span>回到地球</span></Link>
      </header>
      <iframe ref={universeRef} className={styles.scene} src="/memory-universe/index.html?v=2" title="记忆图景宇宙" allow="fullscreen" />
    </main>
  );
}
