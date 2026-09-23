// 首页「导入」选中录音 → 导入页（工单 Gate 2.4/2.5）。
// 复用 pendingEncounters 表（主键 key），新增一个 key，不升 Dexie 版本。
// 存 IndexedDB 而不是模块变量：刷新、热更新之后导入页仍然拿得到文件。
// 清理：导入成功、用户换文件、离开导入页都会删掉；「删除本机全部数据」本来就清这张表。
import { db } from "../../db";

const KEY = "memo-import" as const;
const AUDIO_EXT = /\.(m4a|mp3|wav|aac|amr|ogg|opus|webm|caf)$/i;

/** 首页「导入」选中的文件是不是录音（其余都当照片/视频走遇见流程） */
export function isAudioFile(file: Pick<File, "type" | "name">): boolean {
  // 扩展名优先：有的浏览器把 .m4a 报成 video/mp4，或者干脆不给 type
  return AUDIO_EXT.test(file.name) || file.type.startsWith("audio/");
}

export async function setPendingMemoImport(file: File): Promise<void> {
  await db.pendingEncounters.put({ key: KEY, file, name: file.name, type: file.type, lastModified: file.lastModified, source: "home-import" });
}

/** 读出暂存的录音，但不删：导入失败时用户还能重试 */
export async function peekPendingMemoImport(): Promise<File | null> {
  try {
    const row = await db.pendingEncounters.get(KEY);
    return row ? new File([row.file], row.name, { type: row.type, lastModified: row.lastModified }) : null;
  } catch {
    return null;
  }
}

export async function clearPendingMemoImport(): Promise<void> {
  await db.pendingEncounters.delete(KEY).catch(() => undefined);
}
