/**
 * 对用户说「照片会发给谁」必须是真的。模型供应商由部署方的环境变量决定
 * （Vercel 是百炼，国内服务器是 Agnes），所以不能写死在文案里 ——
 * 黑客松版本就写死了「百炼」，换模型后隐私告知变成了假话。
 *
 * 只能在服务端组件里调用：它读的是服务端环境变量，页面在每个部署自己构建时取值。
 */
const KNOWN_PROVIDERS: Array<[RegExp, string]> = [
  [/dashscope\.aliyuncs\.com$/i, "阿里云百炼"],
  [/agnes-ai\.com$/i, "Agnes AI"],
  [/openai\.com$/i, "OpenAI"],
  [/aiping\.cn$/i, "aiping.cn"],
  [/bigmodel\.cn$/i, "智谱 AI"],
];

function labelForHost(raw: string | undefined): string {
  if (!raw) return "第三方大模型服务商";
  try {
    const host = new URL(raw).host;
    return KNOWN_PROVIDERS.find(([pattern]) => pattern.test(host))?.[1] ?? host;
  } catch {
    return "第三方大模型服务商";
  }
}

/** 识图（照片、视频帧）发给谁：VISION_PROVIDER=zhipu 时是智谱（外部设备接入工单 v2 Gate 0） */
export function visionProviderLabel(): string {
  if (process.env.VISION_PROVIDER?.trim() === "zhipu") return labelForHost(process.env.ZHIPU_BASE_URL?.trim() || "https://open.bigmodel.cn");
  return modelProviderLabel();
}

/** 遇见手记的判断和写作（逐字稿片段）发给谁 */
export function textProviderLabel(): string {
  if (process.env.MEMO_LLM_PROVIDER?.trim() === "zhipu") return labelForHost(process.env.ZHIPU_BASE_URL?.trim() || "https://open.bigmodel.cn");
  return labelForHost(process.env.MEMO_BASE_URL?.trim() || process.env.DASHSCOPE_BASE_URL || "https://dashscope.aliyuncs.com");
}

export function modelProviderLabel(): string {
  const raw = process.env.DASHSCOPE_BASE_URL;
  if (!raw) return "第三方大模型服务商";
  try {
    const host = new URL(raw).host;
    return KNOWN_PROVIDERS.find(([pattern]) => pattern.test(host))?.[1] ?? host;
  } catch {
    return "第三方大模型服务商";
  }
}
