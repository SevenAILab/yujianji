// 从 m4a / mp4 的 mvhd box 读录制时间。语音备忘录导出的文件保留了它（spec §2.4，本机 4 个文件实测）。
// 注意：mvhd.creation_time 是文件创建时间，通常等于开录时间，但不保证；导入时必须让用户看到并可改（startedAtSource = file_metadata）。

const MAC_EPOCH_OFFSET_SEC = 2_082_844_800; // 1904-01-01 → 1970-01-01
const TYPE = [0x6d, 0x76, 0x68, 0x64]; // "mvhd"
const MIN_VALID = Date.UTC(2005, 0, 1);
const MAX_VALID = Date.UTC(2100, 0, 1);

export interface MvhdInfo {
  creationTime: string | null;
  durationSec: number | null;
}

/** 在一段字节里找所有 "mvhd" 出现的位置（type 字段起点） */
export function findTypeOffsets(bytes: Uint8Array): number[] {
  const hits: number[] = [];
  for (let i = 4; i <= bytes.length - 4; i += 1) {
    if (bytes[i] === TYPE[0] && bytes[i + 1] === TYPE[1] && bytes[i + 2] === TYPE[2] && bytes[i + 3] === TYPE[3]) {
      hits.push(i);
    }
  }
  return hits;
}

/**
 * header 从 box 起点（size 字段）开始，至少 40 字节。
 * 用 size（v0 = 108，v1 = 120）和 version 做校验，避免音频数据里恰好出现 "mvhd" 四个字节被误判。
 */
export function parseMvhdHeader(header: Uint8Array): MvhdInfo | null {
  if (header.length < 40) return null;
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  const size = view.getUint32(0);
  const version = view.getUint8(8);
  if (!(version === 0 && size === 108) && !(version === 1 && size === 120)) return null;

  let creation: number;
  let timescale: number;
  let duration: number;
  if (version === 0) {
    creation = view.getUint32(12);
    timescale = view.getUint32(20);
    duration = view.getUint32(24);
  } else {
    creation = Number(view.getBigUint64(12));
    timescale = view.getUint32(28);
    duration = Number(view.getBigUint64(32));
  }
  const ms = (creation - MAC_EPOCH_OFFSET_SEC) * 1000;
  const creationTime = creation > 0 && ms >= MIN_VALID && ms <= MAX_VALID ? new Date(ms).toISOString() : null;
  const durationSec = timescale > 0 && duration > 0 ? duration / timescale : null;
  return { creationTime, durationSec };
}

/** 分段扫描整个文件（moov 可能在文件末尾），每段 4MB、段间重叠 16 字节 */
export async function readMvhdFromBlob(blob: Blob, segmentBytes = 4 * 1024 * 1024, overlap = 16): Promise<MvhdInfo | null> {
  for (let start = 0; start < blob.size; start += segmentBytes - overlap) {
    const end = Math.min(blob.size, start + segmentBytes);
    const bytes = new Uint8Array(await blob.slice(start, end).arrayBuffer());
    for (const typeOffset of findTypeOffsets(bytes)) {
      const boxStart = start + typeOffset - 4;
      const header = new Uint8Array(await blob.slice(boxStart, boxStart + 40).arrayBuffer());
      const info = parseMvhdHeader(header);
      if (info) return info;
    }
    if (end === blob.size) break;
  }
  return null;
}
