/**
 * 从模型输出里抠出 JSON 对象。
 *
 * 换到 agnes-2.5-flash 之后实测：同一张图 4 次里有 2 次返回的 JSON 解析不了。
 * flash 类模型最常见的三种坏法都是「差一点就对」：
 *   - 中文字符串里直接用了英文双引号：它被称为"拿铁"
 *   - 字符串里夹了真实换行
 *   - 对象/数组末尾多一个逗号
 * 这三种都能确定性地修好，不需要重新花一次模型调用。
 * 截断（括号不配对）修不了，照常报错，交给上层重试。
 */
export function extractJsonObject(text: string): unknown {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const candidate = (fenced?.[1] ?? trimmed).trim();
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");

  if (start < 0 || end <= start) {
    throw new Error("模型没有返回 JSON 对象");
  }

  const body = candidate.slice(start, end + 1);
  try {
    return JSON.parse(body);
  } catch {
    // 走下面的修复
  }

  try {
    return JSON.parse(removeTrailingCommas(escapeStrayCharacters(body)));
  } catch {
    throw new Error("模型返回的 JSON 无法解析");
  }
}

/**
 * 逐字扫描，只在「字符串内部」动手：
 * - 遇到英文双引号，往后看第一个非空白字符是不是 , } ] : 或结尾 ——
 *   是就当作字符串结束，不是就说明它是正文里的引号，转义掉；
 * - 字符串里的真实换行 / 制表符转成转义序列。
 */
function escapeStrayCharacters(json: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < json.length; i += 1) {
    const ch = json[i];
    if (!inString) {
      if (ch === '"') inString = true;
      out += ch;
      continue;
    }
    if (ch === "\\") {
      out += ch + (json[i + 1] ?? "");
      i += 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      while (j < json.length && /\s/.test(json[j])) j += 1;
      const next = json[j];
      if (next === undefined || next === "," || next === "}" || next === "]" || next === ":") {
        inString = false;
        out += ch;
      } else {
        out += '\\"';
      }
      continue;
    }
    if (ch === "\n") {
      out += "\\n";
      continue;
    }
    if (ch === "\r") continue;
    if (ch === "\t") {
      out += "\\t";
      continue;
    }
    out += ch;
  }
  return out;
}

function removeTrailingCommas(json: string): string {
  return json.replace(/,\s*([}\]])/g, "$1");
}

/**
 * 解析失败时给日志用的「形状」描述：只有长度和结构特征，绝不包含模型原文 ——
 * 原文里会复述用户的原话。靠这几个字段就能分清是截断还是格式坏了。
 */
export function describeRawShape(text: string): {
  length: number;
  balancedBraces: boolean;
  endsWithBrace: boolean;
  fenced: boolean;
} {
  const t = text.trim();
  const open = (t.match(/\{/g) ?? []).length;
  const close = (t.match(/\}/g) ?? []).length;
  return {
    length: t.length,
    balancedBraces: open === close,
    endsWithBrace: /\}\s*(```)?\s*$/.test(t),
    fenced: t.includes("```"),
  };
}
