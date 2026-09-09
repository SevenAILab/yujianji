"use client";

import { db } from "./db";

/** 政策实质性变更时改这个版本号，会重新征求同意。 */
export const CONSENT_VERSION = "2026-09-10";
export const PRIVACY_UPDATED_AT = "2026 年 9 月 10 日";

const META_KEY = "consent-version";

export async function readConsent(): Promise<string | null> {
  try {
    const row = await db.meta.get(META_KEY);
    return typeof row?.value === "string" ? row.value : null;
  } catch {
    // 读不到就当没同意过：宁可多问一次，也不要在没同意的情况下放行。
    return null;
  }
}

export async function grantConsent(): Promise<void> {
  await db.meta.put({ key: META_KEY, value: CONSENT_VERSION });
}

export function isConsentCurrent(stored: string | null): boolean {
  return stored === CONSENT_VERSION;
}
