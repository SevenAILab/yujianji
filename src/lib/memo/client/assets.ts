"use client";

// 素材池 + 以声定图（外部设备接入工单 v2 Gate 2）。
// 进池：读拍摄时间和位置、算原文件 hash 去重、存 1024px 工作图和 320px 缩略图，不识别、不花钱。
// 写手帐前：每个需要配图的片段按时间挑候选 → 1 张直接用，2–3 张拼图交给识图模型选 → 选中的才去识别成藏品。
// 窗口外的照片不会被送去识别（候选函数保证），每次都写一条过程记录（候选数、窗口内外最近的照片、结果）。
import { nanoid } from "nanoid";
import { apiFetch } from "../../api-client";
import { detectCountryFromPosition } from "../../country";
import { db } from "../../db";
import { toHistoryEntry } from "../../history";
import { readImageCapturedDate } from "../../image-date";
import { readImageLocation } from "../../image-location";
import { recognizeResultSchema } from "../../schema";
import type { Item, RecognizedAi } from "../../types";
import { DEFAULT_MATCH_WINDOW, momentsNeedingPhoto, selectAssetCandidates, usedAssetIds, type MatchWindow } from "../asset-match";
import { dayItemRange } from "../day-match";
import { placeLabel } from "../place";
import { quotesForWriting } from "../select";
import { dayKeyIn, deviceTimeZone } from "../time";
import type { AgentTrace, MediaAsset, Moment, TraceStep } from "../types";
import { describeMemoError, MemoApiError } from "./api";
import { saveTrace } from "./repo";

const WORK_SIDE = 1024;
const THUMB_SIDE = 320;

export interface AssetImportSummary {
  added: number;
  duplicates: number;
  /** 读不到拍摄时间：进池了，但不参与自动配图，等用户确认 */
  missingTime: number;
  failed: number;
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function toJpeg(bitmap: ImageBitmap, maxSide: number, quality: number): Promise<{ buffer: ArrayBuffer; width: number; height: number }> {
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("无法处理这张图片");
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
  if (!blob) throw new Error("无法处理这张图片");
  return { buffer: await blob.arrayBuffer(), width: canvas.width, height: canvas.height };
}

export function bufferToDataUrl(buffer: ArrayBuffer, mime = "image/jpeg"): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:${mime};base64,${btoa(binary)}`;
}

/** 照片进池。同一文件（hash 相同）不重复入池 */
export async function importAssets(files: File[], onProgress?: (done: number, total: number) => void): Promise<AssetImportSummary> {
  const summary: AssetImportSummary = { added: 0, duplicates: 0, missingTime: 0, failed: 0 };
  const timeZone = deviceTimeZone();
  for (const [index, file] of files.entries()) {
    onProgress?.(index, files.length);
    try {
      if (!file.type.startsWith("image/")) throw new Error("not image");
      const original = await file.arrayBuffer();
      const contentHash = await sha256Hex(original);
      if (await db.mediaAssets.where("contentHash").equals(contentHash).count()) {
        summary.duplicates += 1;
        continue;
      }
      const [captured, position] = await Promise.all([readImageCapturedDate(file), readImageLocation(file)]);
      const bitmap = await createImageBitmap(file);
      let work: Awaited<ReturnType<typeof toJpeg>>;
      let thumb: Awaited<ReturnType<typeof toJpeg>>;
      try {
        work = await toJpeg(bitmap, WORK_SIDE, 0.82);
        thumb = await toJpeg(bitmap, THUMB_SIDE, 0.7);
      } finally {
        bitmap.close();
      }
      const fromExif = captured.source === "exif";
      const asset: MediaAsset = {
        id: `ast_${nanoid(12)}`,
        source: "phone",
        capturedAt: fromExif ? captured.date : null,
        capturedAtSource: fromExif ? "exif" : "none",
        ...(fromExif ? {} : { capturedAtHint: captured.date }),
        timeZone,
        lat: position?.lat ?? null,
        lng: position?.lng ?? null,
        mime: "image/jpeg",
        contentHash,
        thumb: thumb.buffer,
        work: work.buffer,
        width: work.width,
        height: work.height,
        status: "pooled",
        createdAt: new Date().toISOString(),
      };
      await db.mediaAssets.put(asset);
      summary.added += 1;
      if (!fromExif) summary.missingTime += 1;
    } catch {
      summary.failed += 1;
    }
  }
  onProgress?.(files.length, files.length);
  return summary;
}

/** 属于某一天的素材（按导入时的设备时区） */
export async function assetsForDay(dayKey: string): Promise<{ timed: MediaAsset[]; untimed: MediaAsset[] }> {
  const [from, to] = dayItemRange(dayKey);
  const timed = (await db.mediaAssets.where("capturedAt").between(from, to, true, true).toArray()).filter((a) => a.capturedAt && dayKeyIn(a.capturedAt, a.timeZone) === dayKey);
  const untimed = (await db.mediaAssets.filter((a) => !a.capturedAt && Boolean(a.capturedAtHint) && dayKeyIn(a.capturedAtHint!, a.timeZone) === dayKey).toArray());
  return { timed, untimed };
}

/** 用户确认：读不到拍摄时间的照片按文件时间算 */
export async function confirmHintTimes(ids: string[]): Promise<number> {
  let changed = 0;
  await db.transaction("rw", db.mediaAssets, async () => {
    for (const id of ids) {
      const asset = await db.mediaAssets.get(id);
      if (!asset || asset.capturedAt || !asset.capturedAtHint) continue;
      await db.mediaAssets.update(id, { capturedAt: asset.capturedAtHint, capturedAtSource: "user" });
      changed += 1;
    }
  });
  return changed;
}

/** 2–3 张缩略图并排拼成一张，左上角标 1、2、3（一次识图调用看全部候选） */
async function buildContactSheet(thumbs: ArrayBuffer[]): Promise<string> {
  const tile = 320;
  const gap = 8;
  const canvas = document.createElement("canvas");
  canvas.width = thumbs.length * tile + (thumbs.length - 1) * gap;
  canvas.height = tile;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("无法拼图");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  for (const [i, buffer] of thumbs.entries()) {
    const bitmap = await createImageBitmap(new Blob([buffer], { type: "image/jpeg" }));
    const scale = Math.min(tile / bitmap.width, tile / bitmap.height);
    const w = bitmap.width * scale;
    const h = bitmap.height * scale;
    const x0 = i * (tile + gap);
    context.drawImage(bitmap, x0 + (tile - w) / 2, (tile - h) / 2, w, h);
    bitmap.close();
    context.fillStyle = "rgba(0,0,0,0.72)";
    context.fillRect(x0, 0, 44, 44);
    context.fillStyle = "#ffffff";
    context.font = "bold 30px sans-serif";
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText(String(i + 1), x0 + 22, 23);
  }
  return canvas.toDataURL("image/jpeg", 0.8);
}

async function pickAmong(moment: Moment, runId: string, sheet: string, count: number): Promise<{ pick: number; trace?: AgentTrace }> {
  const deviceRes = await apiFetch("/api/memo/asset-pick", {
    runId,
    dayKey: moment.dayKey,
    momentId: moment.id,
    quote: quotesForWriting(moment).join(" ").slice(0, 300),
    trigger: moment.trigger.slice(0, 80),
    count,
    sheet,
  });
  const payload = (await deviceRes.json().catch(() => null)) as { pick?: number; trace?: AgentTrace; code?: string; error?: string } | null;
  if (!deviceRes.ok) throw new MemoApiError(payload?.code ?? `HTTP_${deviceRes.status}`, deviceRes.status, payload?.error ?? "识图失败", payload ?? {});
  return { pick: typeof payload?.pick === "number" ? payload.pick : 0, trace: payload?.trace };
}

/** 选中的素材 → 识别 → 藏品（初见 / 重逢）。识别不出来返回 null，素材标成 unrecognized，不再参与 */
async function recognizeAsset(asset: MediaAsset, moment: Moment): Promise<Item | null> {
  const image = bufferToDataUrl(asset.work);
  const history = (await db.items.orderBy("date").toArray()).filter((item) => !item.isSeed).slice(-200);
  const response = await apiFetch("/api/recognize", { image, userNote: quotesForWriting(moment).join(" ").slice(0, 200), history: history.map(toHistoryEntry) });
  const payload = (await response.json().catch(() => null)) as unknown;
  if (!response.ok) {
    const code = (payload as { code?: string } | null)?.code ?? "MODEL_ERROR";
    throw new MemoApiError(code === "MODEL_ERROR" ? "VISION_FAILED" : code, response.status, "识别这张照片失败");
  }
  const result = recognizeResultSchema.parse(payload);
  if (result.unrecognized) {
    await db.mediaAssets.update(asset.id, { status: "unrecognized" });
    return null;
  }
  const relatedOk = result.verdict !== "reunion" || !result.relatedItemId || history.some((item) => item.id === result.relatedItemId);
  const place = moment.place?.name ? placeLabel(moment.place) : "";
  const item: Item = {
    id: `voice_${asset.id}`,
    name: result.name,
    nameEn: result.nameEn ?? undefined,
    category: result.category,
    photo: image,
    place: place || (asset.lat !== null ? "当前位置" : "?"),
    // 和拍照流程一致：有坐标按坐标判国家，判不出或没坐标记 UNK（地图接口要求至少 2 个字符）
    country: asset.lat !== null && asset.lng !== null ? detectCountryFromPosition(asset.lat, asset.lng) || "UNK" : "UNK",
    lat: asset.lat,
    lng: asset.lng,
    locationSource: asset.lat !== null ? "exif" : "unavailable",
    placeSource: place ? "voice" : "unavailable",
    date: asset.capturedAt!,
    dateSource: asset.capturedAtSource === "exif" ? "exif" : "imported",
    userNote: "",
    heard: quotesForWriting(moment).join(" ").slice(0, 200),
    ai: {
      cognition: result.cognition,
      fun: result.fun,
      luck: result.luck,
      question: result.question,
      verdict: relatedOk ? result.verdict : "first",
      relatedItemId: relatedOk ? result.relatedItemId : null,
      memorySentence: result.memorySentence,
    } satisfies RecognizedAi,
    isSeed: false,
    createdAt: new Date().toISOString(),
  };
  await db.items.put(item);
  await db.mediaAssets.update(asset.id, { status: "recognized", itemId: item.id });
  return item;
}

export interface VoiceMatchResult {
  matched: number;
  /** 窗口里没有照片的片段数（交给旧的日终补配图兜底） */
  noCandidate: number;
  /** 有候选但模型都没选中的片段数 */
  rejected: number;
  failed: number;
  /** 送去识图的张数（拼图算候选张数；单张直接识别算 1） */
  sentToVision: number;
}

/**
 * 以声定图：写手帐前先跑，只补还没图的片段，不覆盖已有配图。失败只记过程，不拦写手帐。
 */
export async function runVoiceMatch(dayKey: string, window: MatchWindow = DEFAULT_MATCH_WINDOW): Promise<VoiceMatchResult> {
  const result: VoiceMatchResult = { matched: 0, noCandidate: 0, rejected: 0, failed: 0, sentToVision: 0 };
  const { timed } = await assetsForDay(dayKey);
  const moments = await db.moments.where("dayKey").equals(dayKey).toArray();
  const pending = momentsNeedingPhoto(moments, dayKey);
  if (!timed.length || !pending.length) return result;

  const runId = `v_${dayKey}_${Date.now().toString(36)}`;
  const steps: TraceStep[] = [];
  const startedAt = Date.now();
  const used = usedAssetIds(await db.moments.filter((m) => Boolean(m.assetId)).toArray());
  const byId = new Map(timed.map((a) => [a.id, a]));
  let outcome: AgentTrace["outcome"] = "ok";

  for (const moment of pending) {
    const candidates = selectAssetCandidates(moment.at, timed, { window, exclude: used });
    const diag = `候选 ${candidates.candidates.length} 张（窗口内 ${candidates.inWindow}）${candidates.nearestInside ? `，窗口内最近 ${Math.round(candidates.nearestInside.deltaMs / 1000)}s` : ""}${candidates.nearestOutside ? `，窗口外最近 ${Math.round(candidates.nearestOutside.deltaMs / 1000)}s` : ""}`;
    if (!candidates.candidates.length) {
      result.noCandidate += 1;
      steps.push({ kind: "check", name: "voice_match", ms: 0, summary: `「${moment.trigger || moment.id}」${diag} → 交给日终补配图` });
      continue;
    }
    try {
      let chosen: MediaAsset | undefined;
      if (candidates.candidates.length === 1) {
        chosen = byId.get(candidates.candidates[0].id);
      } else {
        const picks = candidates.candidates.map((c) => byId.get(c.id)!).filter(Boolean);
        result.sentToVision += picks.length;
        const sheet = await buildContactSheet(picks.map((a) => a.thumb));
        const { pick, trace } = await pickAmong(moment, `${runId}_${moment.id}`.replace(/[^A-Za-z0-9_:.-]/g, "").slice(0, 120), sheet, picks.length);
        if (trace) await saveTrace(trace);
        chosen = pick > 0 ? picks[pick - 1] : undefined;
      }
      if (!chosen) {
        result.rejected += 1;
        steps.push({ kind: "check", name: "voice_match", ms: 0, summary: `「${moment.trigger || moment.id}」${diag} → 都对不上，留白` });
        continue;
      }
      if (candidates.candidates.length === 1) result.sentToVision += 1;
      const item = await recognizeAsset(chosen, moment);
      if (!item) {
        result.rejected += 1;
        steps.push({ kind: "check", name: "voice_match", ms: 0, summary: `「${moment.trigger || moment.id}」${diag} → 选中的照片识别不出来，留白` });
        continue;
      }
      const current = await db.moments.get(moment.id);
      if (!current || current.photoId) continue; // 这期间已经有图了，一律不覆盖
      await db.moments.update(moment.id, { photoId: item.id, photoSource: "voice_match", assetId: chosen.id });
      used.add(chosen.id);
      result.matched += 1;
      steps.push({ kind: "check", name: "voice_match", ms: 0, summary: `「${moment.trigger || moment.id}」${diag} → 配上「${item.name}」（${Math.round(((Date.parse(chosen.capturedAt!) - Date.parse(moment.at)) / 1000))}s）` });
    } catch (error) {
      result.failed += 1;
      outcome = "degraded";
      steps.push({ kind: "error", name: "voice_match", ms: 0, summary: `「${moment.trigger || moment.id}」${diag} → 失败：${describeMemoError(error)}` });
    }
  }

  steps.push({ kind: "stage", name: "voice_match", ms: Date.now() - startedAt, summary: `以声定图：配上 ${result.matched} 段，窗口里没照片 ${result.noCandidate} 段，对不上 ${result.rejected} 段，失败 ${result.failed} 段；送识图 ${result.sentToVision} 张（窗口外 0 张）` });
  await saveTrace({ runId, scope: "match", refId: dayKey, dayKey, startedAt: new Date(startedAt).toISOString(), ms: Date.now() - startedAt, costYuan: 0, outcome, steps });
  return result;
}
