const MAX_BODY = 20 * 1024 * 1024 + 64 * 1024;
const ID = '[0-9a-f]{32}';

export function allowedMemoryPath(path: string, method: string) {
  return method === 'GET'
    ? new RegExp(`^(jobs|jobs/${ID}|models/${ID})$`).test(path)
    : method === 'POST' && (path === 'jobs' || new RegExp(`^jobs/${ID}/resume$`).test(path));
}

export async function boundedUpload(request: Request): Promise<Uint8Array> {
  if (Number(request.headers.get('content-length') || 0) > MAX_BODY) throw new Error('UPLOAD_TOO_LARGE');
  const reader = request.body?.getReader();
  if (!reader) throw new Error('EMPTY_UPLOAD');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY) { await reader.cancel(); throw new Error('UPLOAD_TOO_LARGE'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  return body;
}

export async function proxyMemory(request: Request, path: string) {
  if (!allowedMemoryPath(path, request.method)) return Response.json({error: '接口不存在'}, {status: 404});
  const owner = request.headers.get('x-universe-id') || '';
  if (!/^[0-9a-f]{64}$/.test(owner)) return Response.json({error: '记忆空间标识无效'}, {status: 401});
  if (request.method === 'POST') {
    const origin = request.headers.get('origin');
    // Next dev can normalize request.url to localhost even when opened at 127.0.0.1.
    // Match the incoming Host instead of the framework's internal URL hostname.
    if (origin) {
      try {
        if (new URL(origin).host !== (request.headers.get('host') || new URL(request.url).host)) {
          return Response.json({error: '不允许跨站提交'}, {status: 403});
        }
      } catch { return Response.json({error: '请求来源无效'}, {status: 403}); }
    }
  }
  const base = process.env.MEMORY_3D_API_URL || 'http://127.0.0.1:8000';
  const key = process.env.MEMORY_3D_SERVICE_KEY || '';
  let upstream: URL;
  try {
    upstream = new URL(base);
    const local = ['127.0.0.1', 'localhost', '[::1]'].includes(upstream.hostname);
    if (upstream.username || upstream.password || upstream.search || upstream.hash ||
        (!local && (upstream.protocol !== 'https:' || !key)) ||
        !['http:', 'https:'].includes(upstream.protocol)) throw new Error('INVALID_CONFIG');
    upstream = new URL(`${base.replace(/\/$/, '')}/v1/universe/${path}`);
  } catch { return Response.json({error: '记忆建模服务配置不完整'}, {status: 503}); }
  const headers = new Headers({'X-Universe-ID': owner});
  if (key) headers.set('X-Service-Key', key);
  let body: Uint8Array | undefined;
  if (request.method === 'POST' && path === 'jobs') {
    const type = request.headers.get('content-type') || '';
    const idem = request.headers.get('idempotency-key') || '';
    if (!type.startsWith('multipart/form-data;') || !/^[a-zA-Z0-9_-]{8,128}$/.test(idem)) {
      return Response.json({error: '照片上传格式无效'}, {status: 422});
    }
    try { body = await boundedUpload(request); }
    catch { return Response.json({error: '请选择 20 MB 以内的照片'}, {status: 413}); }
    headers.set('Content-Type', type);
    headers.set('Idempotency-Key', idem);
  }
  try {
    const response = await fetch(upstream, {
      method: request.method, headers, body: body as BodyInit | undefined, cache: 'no-store',
      redirect: 'error', signal: AbortSignal.timeout(path.startsWith('models/') ? 180000 : 60000),
    });
    const outgoing = new Headers({'Cache-Control': 'private, no-store'});
    for (const key of ['content-type', 'content-length', 'content-disposition']) {
      const value = response.headers.get(key); if (value) outgoing.set(key, value);
    }
    return new Response(response.body, {status: response.status, headers: outgoing});
  } catch { return Response.json({error: '暂时连接不上建模服务，请稍后重试；已提交任务会保留'}, {status: 503}); }
}
