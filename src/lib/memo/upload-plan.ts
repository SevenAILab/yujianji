// 分块上传的纯计算：nginx 现放行 4MB，块 ≤ 3MB（D3）。

export const CHUNK_BYTES = 3 * 1024 * 1024;

export function chunkCount(size: number, chunkBytes = CHUNK_BYTES): number {
  return Math.max(1, Math.ceil(size / chunkBytes));
}

export function chunkRange(index: number, size: number, chunkBytes = CHUNK_BYTES): { start: number; end: number } {
  const start = index * chunkBytes;
  return { start, end: Math.min(size, start + chunkBytes) };
}

/** 服务端已确认的块之外，还需要发哪些（续传） */
export function pendingChunks(total: number, received: Iterable<number>): number[] {
  const got = new Set(received);
  const out: number[] = [];
  for (let i = 0; i < total; i += 1) if (!got.has(i)) out.push(i);
  return out;
}
