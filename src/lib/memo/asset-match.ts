// 以声定图的确定性候选（外部设备接入工单 v2 Gate 2，纯函数，客户端和测试共用）。
//
// 对每个留下、需要配图、还没有图的片段（时刻 T = 第一句我的话的开始时间）：
// - 只看窗口 [T − before, T + after] 内、拍摄时间已知、还没被用过的素材；窗口可配，默认 [−120s, +60s]
//   （开口说话往往比看到东西晚一点）。窗口值没有实测依据，所以每次都返回诊断信息，日后用真实数据校准；
// - 按离 T 的距离排序，最多取 max 张送识图；
// - 间隔不到 spacing（默认 3 秒）的照片只在"送识图的名额"上让位，不删除：连拍时 3 秒内也可能是完全不同的东西。
// 窗口外的素材永远不进候选——这是"窗口外照片送识图次数为 0"的保证。
import { PHOTO_CATEGORIES } from "./guards";
import { compareForPhoto, effectiveDecision, quotesForWriting } from "./select";
import type { MediaAsset, Moment } from "./types";

export interface MatchWindow {
  beforeMs: number;
  afterMs: number;
  /** 一个片段最多送几张给识图 */
  max: number;
  /** 间隔小于它的照片在名额上让位 */
  spacingMs: number;
}

export const DEFAULT_MATCH_WINDOW: MatchWindow = { beforeMs: 120_000, afterMs: 60_000, max: 3, spacingMs: 3_000 };

export type AssetLite = Pick<MediaAsset, "id" | "capturedAt" | "source" | "status">;

export interface CandidateResult {
  candidates: { id: string; deltaMs: number }[];
  /** 窗口内一共有多少张（含没拿到名额的） */
  inWindow: number;
  nearestInside?: { id: string; deltaMs: number };
  nearestOutside?: { id: string; deltaMs: number };
}

function timeOf(asset: AssetLite): number | null {
  if (!asset.capturedAt) return null;
  const t = Date.parse(asset.capturedAt);
  return Number.isFinite(t) ? t : null;
}

export function selectAssetCandidates(
  momentAt: string,
  assets: AssetLite[],
  opts: { window?: Partial<MatchWindow>; exclude?: ReadonlySet<string> } = {},
): CandidateResult {
  const w = { ...DEFAULT_MATCH_WINDOW, ...opts.window };
  const at = Date.parse(momentAt);
  if (!Number.isFinite(at)) return { candidates: [], inWindow: 0 };
  const usable = assets
    .filter((a) => a.status !== "unrecognized" && !opts.exclude?.has(a.id))
    .map((a) => ({ id: a.id, t: timeOf(a) }))
    .filter((a): a is { id: string; t: number } => a.t !== null)
    .map((a) => ({ id: a.id, t: a.t, deltaMs: a.t - at }));
  const inside = usable.filter((a) => a.deltaMs >= -w.beforeMs && a.deltaMs <= w.afterMs).sort((a, b) => Math.abs(a.deltaMs) - Math.abs(b.deltaMs) || a.id.localeCompare(b.id));
  const outside = usable.filter((a) => a.deltaMs < -w.beforeMs || a.deltaMs > w.afterMs).sort((a, b) => Math.abs(a.deltaMs) - Math.abs(b.deltaMs));

  const chosen: typeof inside = [];
  const deferred: typeof inside = [];
  for (const a of inside) {
    if (chosen.length >= w.max) break;
    if (chosen.some((c) => Math.abs(c.t - a.t) < w.spacingMs)) deferred.push(a);
    else chosen.push(a);
  }
  // 名额没用完时，让过位的按距离补上
  for (const a of deferred) {
    if (chosen.length >= w.max) break;
    chosen.push(a);
  }
  chosen.sort((a, b) => Math.abs(a.deltaMs) - Math.abs(b.deltaMs) || a.id.localeCompare(b.id));

  return {
    candidates: chosen.map((a) => ({ id: a.id, deltaMs: a.deltaMs })),
    inWindow: inside.length,
    ...(inside[0] ? { nearestInside: { id: inside[0].id, deltaMs: inside[0].deltaMs } } : {}),
    ...(outside[0] ? { nearestOutside: { id: outside[0].id, deltaMs: outside[0].deltaMs } } : {}),
  };
}

/** 哪些片段要配图：留下、讲的是眼前的东西、还没有图、有我的原话；按配图优先级排好 */
export function momentsNeedingPhoto(moments: Moment[], dayKey: string): Moment[] {
  return moments
    .filter((m) => m.dayKey === dayKey && !m.photoId && effectiveDecision(m) === "keep" && PHOTO_CATEGORIES.has(m.category) && quotesForWriting(m).length > 0)
    .sort(compareForPhoto);
}

/** 已经被某个片段用掉的素材（任何一天） */
export function usedAssetIds(moments: Pick<Moment, "assetId">[]): Set<string> {
  return new Set(moments.map((m) => m.assetId).filter((id): id is string => Boolean(id)));
}
