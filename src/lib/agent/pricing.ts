// 价格：数值取方案附录（阿里云官方价格页，9/12 核实）。
// 没核实到的输出价格按同档输入价的 6 倍保守估算，标 estimated，过程页显示"含估算"。

export interface ModelPrice {
  inputPerM: number;
  outputPerM: number;
  /** 输出价没核实，按输入价 × 6 估算 */
  outputEstimated: boolean;
}

const PRICES: Record<string, ModelPrice> = {
  "qwen3.5-plus": { inputPerM: 0.8, outputPerM: 4.8, outputEstimated: false },
  "qwen3.5-flash": { inputPerM: 0.2, outputPerM: 1.2, outputEstimated: true }, // 估算
  "qwen3-max": { inputPerM: 2.5, outputPerM: 15, outputEstimated: true }, // 输入价"2.5 元起"，输出估算
};

/** 未登记的模型（eval 对比用的外部模型等）一律按 qwen3-max 档估算 */
const FALLBACK: ModelPrice = { inputPerM: 2.5, outputPerM: 15, outputEstimated: true };

/** 录音文件识别，元/秒 */
export const ASR_PRICE_PER_SEC: Record<string, number> = {
  "fun-asr": 0.00022,
  "paraformer-v2": 0.00008,
};

/**
 * 带日期的快照（如 qwen3.5-plus-2026-04-20）和通用名同价。
 * 通用名免费额度用完、换用还有额度的快照时，费用统计不至于按兜底价多算三倍。
 */
export function priceFor(modelId: string): ModelPrice & { known: boolean } {
  const price = PRICES[modelId] ?? PRICES[modelId.replace(/-\d{4}-\d{2}-\d{2}$/, "")];
  return price ? { ...price, known: true } : { ...FALLBACK, known: false };
}

export function tokenCostYuan(modelId: string, inputTokens?: number, outputTokens?: number): { yuan: number; estimated: boolean } {
  const price = priceFor(modelId);
  const yuan = ((inputTokens ?? 0) * price.inputPerM + (outputTokens ?? 0) * price.outputPerM) / 1_000_000;
  return { yuan, estimated: price.outputEstimated || !price.known };
}

export function asrCostYuan(model: string, seconds: number): { yuan: number; estimated: boolean } {
  const perSec = ASR_PRICE_PER_SEC[model];
  return perSec === undefined ? { yuan: seconds * 0.00022, estimated: true } : { yuan: seconds * perSec, estimated: false };
}

/** 联网搜索按次计费的价格未核实，不计入费用，但 trace 标 estimated */
export const SEARCH_COST_UNVERIFIED = true;
